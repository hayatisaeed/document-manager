"""Persian/RTL, callouts, code blocks and Jupyter notebooks."""
import json
import unittest
import zipfile

from core.services import kernels, pandoc
from core.services import project_files as pf

from .test_api import BaseTest

PERSIAN = "این یک متن فارسی است که در آن کلمه‌ی English و نرم‌افزار Git آمده است."


def export_bytes(response) -> bytes:
    return b"".join(response.streaming_content)


class PersianTextTests(BaseTest):
    def test_word_count_keeps_half_space_words_together(self):
        self.assertEqual(pf.word_count("می‌روم به خانه", "markdown"), 3)

    def test_search_ignores_arabic_vs_persian_letter_forms(self):
        slug = self.create()
        self.c.put(self.api(slug, "file/?path=notes/ideas.md"), {"content": "کتاب‌های یادداشت\n"}, format="json")
        # Typed with Arabic kaf/yeh and a space instead of the half-space.
        hits = self.c.get(self.api(slug, "search/"), {"q": "كتاب هاي"}).data
        self.assertEqual([h["path"] for h in hits], ["notes/ideas.md"])

    def test_language_detection(self):
        self.assertEqual(pandoc.detect_language(PERSIAN), "fa")
        self.assertEqual(pandoc.detect_language("Mostly English with one فارسی word"), "en")

    def test_ui_preferences_saved(self):
        r = self.c.put("/api/settings/", {"ui_language": "fa", "theme": "dark", "calendar": "jalali"}, format="json")
        self.assertEqual((r.data["ui_language"], r.data["theme"], r.data["calendar"]), ("fa", "dark", "jalali"))
        r = self.c.put("/api/settings/", {"theme": "neon"}, format="json")
        self.assertEqual(r.data["theme"], "dark")


@unittest.skipUnless(pandoc.available(), "pandoc not installed")
class BidiExportTests(BaseTest):
    def setUp(self):
        super().setUp()
        self.slug = self.create("کتاب من")
        self.c.put(self.api(self.slug, "file/?path=manuscript/01-introduction.md"), {
            "content": f"# مقدمه\n\n{PERSIAN}\n\nAn English paragraph with a فارسی word.\n"}, format="json")

    def test_html_export_marks_directions(self):
        html = export_bytes(self.c.post(self.api(self.slug, "export/"), {"format": "html"}, format="json")).decode()
        self.assertIn('dir="rtl"', html)
        self.assertIn('<div dir="ltr" lang="en">', html)
        self.assertIn('lang="en">English</span>', html)
        self.assertIn("unicode-bidi: plaintext", html)

    def test_docx_export_has_bidi_paragraphs(self):
        r = self.c.post(self.api(self.slug, "export/"), {"format": "docx"}, format="json")
        self.assertEqual(r.status_code, 200)
        import io
        xml = zipfile.ZipFile(io.BytesIO(export_bytes(r))).read("word/document.xml").decode()
        self.assertIn("<w:bidi", xml)
        self.assertIn("<w:rtl", xml)

    @unittest.skipUnless("lualatex" in pandoc.pdf_engines(), "LuaLaTeX not installed")
    def test_persian_pdf(self):
        r = self.c.post(self.api(self.slug, "export/"), {"format": "pdf"}, format="json")
        self.assertEqual(r.status_code, 200, getattr(r, "data", None))
        self.assertTrue(export_bytes(r).startswith(b"%PDF"))

    def test_preview_is_standalone_with_theme_and_font(self):
        r = self.c.post(self.api(self.slug, "preview/"), {"path": "manuscript/01-introduction.md",
                                                         "content": PERSIAN, "theme": "dark"}, format="json")
        html = r.data["html"]
        self.assertIn('data-theme="dark"', html)
        self.assertIn("/api/fonts/Vazirmatn-Regular.ttf", html)
        self.assertEqual(self.c.get("/api/fonts/Vazirmatn-Regular.ttf").status_code, 200)
        self.assertEqual(self.c.get("/api/fonts/secret.ttf").status_code, 404)


@unittest.skipUnless(pandoc.available(), "pandoc not installed")
class CalloutAndCodeTests(BaseTest):
    def setUp(self):
        super().setUp()
        self.slug = self.create()
        self.c.put(self.api(self.slug, "file/?path=manuscript/01-introduction.md"), {
            "content": "# Intro\n\n> [!warning] Mind the gap\n> Body text.\n\n```python\nprint('hi')\n```\n"},
            format="json")
        self.c.post(self.api(self.slug, "file/"), {"path": "manuscript/02-rich.html", "add_to_manuscript": True,
                    "content": '<div class="callout" data-callout="tip" data-title="Rich tip"><p>From rich text.</p>'
                               '</div><pre><code class="language-python">x = 1</code></pre>'}, format="json")
        self.c.post(self.api(self.slug, "file/"), {"path": "manuscript/03-latex.tex", "add_to_manuscript": True,
                    "content": "\\begin{callout}{danger}{Latex danger}\nFrom LaTeX.\n\\end{callout}\n"},
                    format="json")

    def test_html_export_renders_all_callout_syntaxes(self):
        html = export_bytes(self.c.post(self.api(self.slug, "export/"), {"format": "html"}, format="json")).decode()
        for cls, title in (("callout-warning", "Mind the gap"), ("callout-tip", "Rich tip"),
                           ("callout-danger", "Latex danger")):
            self.assertIn(cls, html)
            self.assertIn(title, html)
        self.assertIn('class="sourceCode python"', html)  # highlighted code
        self.assertIn('class="sourceCode python"', html.split("Rich tip")[1])  # rich-text code block too

    def test_dark_html_export(self):
        html = export_bytes(self.c.post(self.api(self.slug, "export/"),
                                        {"format": "html", "theme": "dark"}, format="json")).decode()
        self.assertIn('data-theme="dark"', html)

    def test_docx_callout_becomes_table(self):
        import io
        r = self.c.post(self.api(self.slug, "export/"), {"format": "docx"}, format="json")
        xml = zipfile.ZipFile(io.BytesIO(export_bytes(r))).read("word/document.xml").decode()
        self.assertIn("<w:tbl>", xml)
        self.assertIn("Mind the gap", xml)

    def test_latex_export_uses_tcolorbox(self):
        tex = export_bytes(self.c.post(self.api(self.slug, "export/"), {"format": "latex"}, format="json")).decode()
        self.assertIn("\\begin{dmcallout}{dmcalloutwarning}{Mind the gap}", tex)
        self.assertIn("\\newtcolorbox{dmcallout}", tex)

    @unittest.skipUnless(pandoc.pdf_engines(), "no LaTeX engine")
    def test_pdf_with_callouts_and_dark_theme(self):
        r = self.c.post(self.api(self.slug, "export/"), {"format": "pdf", "theme": "dark"}, format="json")
        self.assertEqual(r.status_code, 200, getattr(r, "data", None))


class NotebookTests(BaseTest):
    @staticmethod
    def nb(outputs=None, source="print('hi')"):
        return json.dumps({"cells": [
            {"cell_type": "markdown", "metadata": {}, "source": "# Results\n\nWe measured things."},
            {"cell_type": "code", "metadata": {}, "execution_count": 1, "source": source,
             "outputs": outputs or []}], "metadata": {}, "nbformat": 4, "nbformat_minor": 5})

    def test_create_save_normalises_and_counts_words(self):
        slug = self.create()
        r = self.c.post(self.api(slug, "file/"), {"path": "manuscript/02-analysis.ipynb", "add_to_manuscript": True,
                                                  "title": "Analysis"}, format="json")
        self.assertEqual(r.status_code, 201)
        nb = json.loads(self.c.get(self.api(slug, "file/"), {"path": "manuscript/02-analysis.ipynb"}).data["content"])
        self.assertEqual(nb["nbformat"], 4)
        self.c.put(self.api(slug, "file/?path=manuscript/02-analysis.ipynb"), {"content": self.nb()}, format="json")
        saved = (self.projects / slug / "manuscript/02-analysis.ipynb").read_text()
        self.assertTrue(saved.startswith('{\n "cells": ['))  # Jupyter's own layout (indent=1, sorted keys)
        stats = self.c.get(self.api(slug, "stats/")).data
        self.assertEqual([c["words"] for c in stats["chapters"] if c["path"].endswith(".ipynb")], [4])

    def test_invalid_notebook_rejected(self):
        slug = self.create()
        r = self.c.put(self.api(slug, "file/?path=notes/x.ipynb"), {"content": "{not json"}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_notebook_diff_is_readable_text(self):
        slug = self.create()
        path = "notes/a.ipynb"
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": self.nb()}, format="json")
        self.c.post(self.api(slug, "git/commit/"), {"message": "nb"}, format="json")
        out = [{"output_type": "display_data", "data": {"image/png": "iVBORw0KGgo=", "text/plain": "<Figure>"},
                "metadata": {}}]
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": self.nb(out, "plot()")}, format="json")
        patch = self.c.get(self.api(slug, "git/diff/")).data["patch"]
        self.assertIn("-print('hi')", patch)
        self.assertIn("+plot()", patch)
        self.assertIn("[image/png", patch)
        self.assertNotIn('"cell_type"', patch)

    @unittest.skipUnless(pandoc.available(), "pandoc not installed")
    def test_notebook_exports_with_outputs(self):
        slug = self.create()
        out = [{"output_type": "stream", "name": "stdout", "text": "hello from the kernel\n"}]
        self.c.post(self.api(slug, "file/"), {"path": "manuscript/02-nb.ipynb", "add_to_manuscript": True,
                                              "content": self.nb(out)}, format="json")
        html = export_bytes(self.c.post(self.api(slug, "export/"), {"format": "html"}, format="json")).decode()
        self.assertIn("We measured things", html)
        self.assertIn("hello from the kernel", html)

    @unittest.skipUnless(kernels.available(), "no Jupyter kernel installed")
    def test_run_cells_keeps_state(self):
        slug = self.create()
        path = "notes/run.ipynb"
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": self.nb()}, format="json")
        try:
            r = self.c.post(self.api(slug, "kernel/execute/"), {"path": path, "code": "x = 21\nprint('ok')"},
                            format="json")
            self.assertEqual(r.status_code, 200, r.data)
            self.assertEqual(r.data["outputs"][0]["text"], "ok\n")
            r = self.c.post(self.api(slug, "kernel/execute/"), {"path": path, "code": "x * 2"}, format="json")
            self.assertEqual(r.data["outputs"][0]["data"]["text/plain"], "42")
            r = self.c.post(self.api(slug, "kernel/execute/"), {"path": path, "code": "1/0"}, format="json")
            self.assertEqual(r.data["status"], "error")
            self.assertEqual(r.data["outputs"][0]["ename"], "ZeroDivisionError")
        finally:
            self.c.post(self.api(slug, "kernel/shutdown/"), {"path": path}, format="json")


@unittest.skipUnless(pandoc.available(), "pandoc not installed")
class RtlLayoutRegressionTests(BaseTest):
    """Bugs found by exporting a real Persian book."""

    def setUp(self):
        super().setUp()
        self.slug = self.create("سفر به جزیره")
        self.c.put(self.api(self.slug, "file/?path=manuscript/01-introduction.md"), {
            "content": f"# مقدمه\n\n{PERSIAN}\n\n> [!warning] هشدار\n> متن.\n\n```python\nprint('سلام')\n```\n"},
            format="json")

    def test_persian_project_gets_persian_starter_titles(self):
        manifest = self.c.get(self.api(self.slug, "manifest/")).data
        self.assertEqual(manifest["language"], "fa")
        self.assertEqual(manifest["files"]["manuscript/01-introduction.md"]["title"], "مقدمه")

    def test_code_blocks_stay_left_to_right_and_boxes_are_not_mirrored(self):
        tex = export_bytes(self.c.post(self.api(self.slug, "export/"), {"format": "latex"}, format="json")).decode()
        code = tex.index("\\begin{Shaded}")
        self.assertGreater(code, tex.rindex("\\begin{otherlanguage}{english}", 0, code))
        self.assertIn("layout=graphics", tex)  # babel: TikZ boxes in RTL text
        self.assertIn("fallback=dmpersian", tex)  # Persian glyphs inside code


@unittest.skipUnless(kernels.available(), "no Jupyter kernel installed")
class WidgetBridgeTests(BaseTest):
    def test_slider_roundtrip_and_output_capture(self):
        slug = self.create()
        path = "notes/w.ipynb"
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": NotebookTests.nb(None)}, format="json")
        run = lambda code: self.c.post(self.api(slug, "kernel/execute/"), {"path": path, "code": code}, format="json").data
        try:
            r = run("import ipywidgets as w\ns = w.IntSlider(value=3)\ns")
            view = r["outputs"][0]["data"]["application/vnd.jupyter.widget-view+json"]
            ev = self.c.get(self.api(slug, "kernel/events/"), {"path": path, "since": 0, "wait": 0}).data
            opens = [e for e in ev["events"] if e["msg_type"] == "comm_open"]
            model = next(e for e in opens if e["content"]["comm_id"] == view["model_id"])
            self.assertEqual(model["content"]["data"]["state"]["value"], 3)

            # The browser moves the slider.
            self.c.post(self.api(slug, "kernel/comm/"), {"path": path, "msg_type": "comm_msg", "content": {
                "comm_id": view["model_id"], "data": {"method": "update", "state": {"value": 7}, "buffer_paths": []}}},
                format="json")
            import time
            time.sleep(0.5)
            self.assertEqual(run("s.value")["outputs"][0]["data"]["text/plain"], "7")

            # Output widgets capture prints: they reach the browser as events, not the cell.
            r = run("out = w.Output()\ndisplay(out)\nwith out:\n    print('captured!')\nprint('cell output')")
            texts = [o.get("text", "") for o in r["outputs"] if o["output_type"] == "stream"]
            self.assertEqual(texts, ["cell output\n"])
            ev = self.c.get(self.api(slug, "kernel/events/"), {"path": path, "since": ev["seq"], "wait": 0}).data
            captured = [e for e in ev["events"] if e["captured"] and e["msg_type"] == "stream"]
            self.assertEqual(captured[0]["content"]["text"], "captured!\n")
        finally:
            self.c.post(self.api(slug, "kernel/shutdown/"), {"path": path}, format="json")


class NotebookMergeTests(BaseTest):
    """Notebooks are merged cell by cell instead of as JSON text."""

    @staticmethod
    def nb(*cells):
        return json.dumps({"cells": [{"id": cid, "cell_type": "code", "metadata": {}, "source": src,
                                      "outputs": [], "execution_count": None} for cid, src in cells],
                           "metadata": {}, "nbformat": 4, "nbformat_minor": 5})

    def setUp(self):
        super().setUp()
        self.slug = self.create()
        self.path = "notes/analysis.ipynb"
        self.put(self.nb(("a", "load()"), ("b", "clean()"), ("c", "plot()")))
        self.c.post(self.api(self.slug, "git/commit/"), {"message": "base"}, format="json")
        self.c.post(self.api(self.slug, "git/branches/"), {"name": "other"}, format="json")

    def put(self, content):
        r = self.c.put(self.api(self.slug, f"file/?path={self.path}"), {"content": content}, format="json")
        self.assertEqual(r.status_code, 200, r.data)

    def commit(self, msg):
        self.c.post(self.api(self.slug, "git/commit/"), {"message": msg}, format="json")

    def cells(self):
        nb = json.loads(self.c.get(self.api(self.slug, "file/"), {"path": self.path}).data["content"])
        return [(c["id"], c["source"]) for c in nb["cells"]]

    def test_edits_to_different_cells_merge_automatically(self):
        # Both sides append a cell at the end: a guaranteed conflict for a text merge.
        self.put(self.nb(("a", "load()"), ("b", "clean()"), ("c", "plot(color='red')"), ("t", "export()")))
        self.commit("theirs: plot colour, export")
        self.c.post(self.api(self.slug, "git/checkout/"), {"name": "main"}, format="json")
        self.put(self.nb(("a", "load('data.csv')"), ("b", "clean()"), ("c", "plot()"), ("o", "summary()")))
        self.commit("ours: load file, add summary")
        r = self.c.post(self.api(self.slug, "git/merge/"), {"name": "other"}, format="json")
        self.assertEqual(r.data["conflicts"], [])
        self.assertEqual(r.data["auto_merged"], [self.path])
        self.assertEqual(self.cells(), [("a", "load('data.csv')"), ("b", "clean()"), ("c", "plot(color='red')"),
                                        ("t", "export()"), ("o", "summary()")])
        st = self.c.get(self.api(self.slug, "git/status/")).data
        self.assertFalse(st["merging"])  # merge commit was completed
        self.assertEqual(len(self.c.get(self.api(self.slug, "git/log/")).data[0]["parents"]), 2)

    def test_same_cell_conflict_is_resolved_per_cell(self):
        self.put(self.nb(("a", "load()"), ("b", "clean(strict=True)"), ("c", "plot()")))
        self.commit("theirs")
        self.c.post(self.api(self.slug, "git/checkout/"), {"name": "main"}, format="json")
        self.put(self.nb(("a", "load()"), ("b", "clean(fast=True)"), ("c", "plot()"), ("d", "save()")))
        self.commit("ours")
        r = self.c.post(self.api(self.slug, "git/merge/"), {"name": "other"}, format="json")
        self.assertEqual(r.data["conflicts"], [self.path])
        v = self.c.get(self.api(self.slug, "git/conflict/"), {"path": self.path}).data["notebook"]
        conflict = [e for e in v["entries"] if e["status"] == "conflict"]
        self.assertEqual([e["key"] for e in conflict], ["b"])
        self.assertEqual(conflict[0]["ours"]["source"], "clean(fast=True)")
        self.assertEqual(conflict[0]["theirs"]["source"], "clean(strict=True)")
        # Missing choice is refused; "both" keeps the two versions.
        bad = self.c.post(self.api(self.slug, "git/conflict/"), {"path": self.path, "choices": {}}, format="json")
        self.assertEqual(bad.status_code, 409)
        self.c.post(self.api(self.slug, "git/conflict/"), {"path": self.path, "choices": {"b": "both"}}, format="json")
        self.assertEqual([s for _, s in self.cells()],
                         ["load()", "clean(fast=True)", "clean(strict=True)", "plot()", "save()"])
        self.assertEqual(len({i for i, _ in self.cells()}), 5)  # ids stay unique

    def test_notebooks_without_ids_align_by_content(self):
        from core.services import nbmerge
        strip = lambda nb: {**nb, "cells": [{k: v for k, v in c.items() if k != "id"} for c in nb["cells"]]}
        base = strip(json.loads(self.nb(("a", "x = 1"), ("b", "y = 2"))))
        ours = strip(json.loads(self.nb(("a", "x = 10"), ("b", "y = 2"))))
        theirs = strip(json.loads(self.nb(("a", "x = 1"), ("b", "y = 20"))))
        result = nbmerge.merge(base, ours, theirs)
        self.assertEqual(result["conflicts"], 0)
        self.assertEqual([e["cell"]["source"] for e in result["entries"]], ["x = 10", "y = 20"])
