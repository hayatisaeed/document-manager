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
    def nb(self, outputs=None, source="print('hi')"):
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
