import shutil
import subprocess
import tempfile
from pathlib import Path

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from core.services import pandoc


class Client(APIClient):
    """API client that sends the header required for state-changing requests."""

    def generic(self, method, path, *args, **kwargs):
        kwargs.setdefault("HTTP_X_DM_CLIENT", "1")
        return super().generic(method, path, *args, **kwargs)


class BaseTest(TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.projects = self.tmp / "projects"
        self.projects.mkdir()
        self.override = override_settings(PROJECTS_DIR=self.projects)
        self.override.enable()
        self.c = Client()
        self.c.put("/api/settings/", {"author_name": "Ada", "author_email": "ada@example.com"}, format="json")

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def create(self, title="My Book", fmt="markdown"):
        r = self.c.post("/api/projects/", {"title": title, "format": fmt, "kind": "book"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        return r.data["slug"]

    def api(self, slug, path):
        return f"/api/projects/{slug}/{path}"


class ProjectTests(BaseTest):
    def test_create_scaffolds_repo_with_initial_commit(self):
        slug = self.create()
        self.assertEqual(slug, "my-book")
        detail = self.c.get(self.api(slug, "")).data
        self.assertEqual(detail["manifest"]["manuscript"], ["manuscript/01-introduction.md"])
        log = self.c.get(self.api(slug, "git/log/")).data
        self.assertEqual(len(log), 1)
        self.assertEqual(log[0]["author"], "Ada")
        self.assertEqual(self.c.get(self.api(slug, "git/status/")).data["files"], [])

    def test_csrf_header_required(self):
        r = APIClient().post("/api/projects/", {"title": "x"}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_path_traversal_rejected(self):
        slug = self.create()
        for bad in ("../../etc/passwd", ".git/config", "/etc/passwd"):
            r = self.c.get(self.api(slug, "file/"), {"path": bad})
            self.assertEqual(r.status_code, 400, bad)


class FileAndGitTests(BaseTest):
    def test_edit_commit_history_diff_restore(self):
        slug = self.create()
        path = "manuscript/01-introduction.md"
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": "# Intro\n\nFirst draft.\n"}, format="json")
        st = self.c.get(self.api(slug, "git/status/")).data
        self.assertEqual([(f["path"], f["status"]) for f in st["files"]], [(path, "modified")])
        diff = self.c.get(self.api(slug, "git/diff/")).data
        self.assertIn("+First draft.", diff["patch"])

        r = self.c.post(self.api(slug, "git/commit/"), {"message": "Draft intro"}, format="json")
        self.assertEqual(r.status_code, 201)
        log = self.c.get(self.api(slug, "git/log/"), {"path": path}).data
        self.assertEqual([c["subject"] for c in log], ["Draft intro", "Create project: My Book"])

        show = self.c.get(self.api(slug, f"git/commits/{log[0]['sha']}/")).data
        self.assertEqual(show["files"][0]["path"], path)
        self.assertIn("+First draft.", show["patch"])

        old = self.c.get(self.api(slug, "git/file-at/"), {"ref": log[1]["sha"], "path": path}).data
        self.assertEqual(old["content"], "# Introduction\n\n")
        self.c.post(self.api(slug, "git/restore/"), {"ref": log[1]["sha"], "path": path}, format="json")
        self.assertEqual(self.c.get(self.api(slug, "file/"), {"path": path}).data["content"], "# Introduction\n\n")

    def test_new_untracked_file_shows_in_diff_and_discard(self):
        slug = self.create()
        self.c.post(self.api(slug, "file/"), {"path": "manuscript/02-two.md", "add_to_manuscript": True}, format="json")
        manifest = self.c.get(self.api(slug, "manifest/")).data
        self.assertIn("manuscript/02-two.md", manifest["manuscript"])
        diff = self.c.get(self.api(slug, "git/diff/"), {"path": "manuscript/02-two.md"}).data
        self.assertIn("+# Two", diff["patch"])
        self.c.post(self.api(slug, "git/discard/"), {"path": "manuscript/02-two.md"}, format="json")
        self.assertEqual(self.c.get(self.api(slug, "file/"), {"path": "manuscript/02-two.md"}).status_code, 404)

    def test_commit_selected_paths_only(self):
        slug = self.create()
        self.c.post(self.api(slug, "file/"), {"path": "notes/a.md"}, format="json")
        self.c.post(self.api(slug, "file/"), {"path": "notes/b.md"}, format="json")
        self.c.post(self.api(slug, "git/commit/"), {"message": "Add a", "paths": ["notes/a.md"]}, format="json")
        remaining = {f["path"] for f in self.c.get(self.api(slug, "git/status/")).data["files"]}
        self.assertIn("notes/b.md", remaining)
        self.assertNotIn("notes/a.md", remaining)

    def test_rename_updates_manifest(self):
        slug = self.create()
        self.c.post(self.api(slug, "move/"), {"from": "manuscript/01-introduction.md",
                                              "to": "manuscript/01-opening.md"}, format="json")
        manifest = self.c.get(self.api(slug, "manifest/")).data
        self.assertEqual(manifest["manuscript"], ["manuscript/01-opening.md"])
        self.assertIn("manuscript/01-opening.md", manifest["files"])

    def test_html_saved_one_block_per_line(self):
        slug = self.create(fmt="html")
        path = "manuscript/01-introduction.html"
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": "<h1>A</h1><p>One</p><p>Two</p>"}, format="json")
        content = self.c.get(self.api(slug, "file/"), {"path": path}).data["content"]
        self.assertEqual(content, "<h1>A</h1>\n<p>One</p>\n<p>Two</p>\n")

    def test_branch_merge_with_conflict_resolution(self):
        slug = self.create()
        path = "manuscript/01-introduction.md"
        self.c.post(self.api(slug, "git/branches/"), {"name": "alt-ending"}, format="json")
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": "# Intro\n\nBranch text.\n"}, format="json")
        self.c.post(self.api(slug, "git/commit/"), {"message": "branch edit"}, format="json")
        self.c.post(self.api(slug, "git/checkout/"), {"name": "main"}, format="json")
        self.c.put(self.api(slug, f"file/?path={path}"), {"content": "# Intro\n\nMain text.\n"}, format="json")
        self.c.post(self.api(slug, "git/commit/"), {"message": "main edit"}, format="json")

        r = self.c.post(self.api(slug, "git/merge/"), {"name": "alt-ending"}, format="json")
        self.assertEqual(r.data["conflicts"], [path])
        versions = self.c.get(self.api(slug, "git/conflict/"), {"path": path}).data
        self.assertIn("Main text.", versions["ours"])
        self.assertIn("Branch text.", versions["theirs"])
        self.assertIn("<<<<<<<", versions["working"])

        # Cannot commit while conflicts remain.
        r = self.c.post(self.api(slug, "git/commit/"), {"message": "merge"}, format="json")
        self.assertEqual(r.status_code, 409)
        self.c.post(self.api(slug, "git/conflict/"), {"path": path, "content": "# Intro\n\nBoth.\n"}, format="json")
        r = self.c.post(self.api(slug, "git/commit/"), {"message": "Merge alt-ending"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        log = self.c.get(self.api(slug, "git/log/")).data
        self.assertEqual(len(log[0]["parents"]), 2)
        self.assertFalse(self.c.get(self.api(slug, "git/status/")).data["merging"])

    def test_option_injection_rejected(self):
        slug = self.create()
        r = self.c.post(self.api(slug, "git/checkout/"), {"name": "--orphan=x"}, format="json")
        self.assertEqual(r.status_code, 409)
        r = self.c.post(self.api(slug, "git/remotes/"), {"name": "o", "url": "ext::sh -c touch% /tmp/pwned"},
                        format="json")
        self.assertEqual(r.status_code, 409)

    def test_push_pull_between_two_collaborators(self):
        bare = self.tmp / "shared.git"
        subprocess.run(["git", "init", "--bare", str(bare)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(bare), "symbolic-ref", "HEAD", "refs/heads/main"], check=True, capture_output=True)
        slug = self.create()
        self.c.post(self.api(slug, "git/remotes/"), {"name": "origin", "url": str(bare)}, format="json")
        r = self.c.post(self.api(slug, "git/push/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.data)

        # Collaborator clones the same repo.
        r = self.c.post("/api/projects/", {"clone_url": str(bare), "title": "Colleague copy"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        other = r.data["slug"]
        self.c.put(self.api(other, "file/?path=notes/ideas.md"), {"content": "# Ideas\n\n- from colleague\n"},
                   format="json")
        self.c.post(self.api(other, "git/commit/"), {"message": "colleague idea"}, format="json")
        self.assertEqual(self.c.post(self.api(other, "git/push/"), {}, format="json").status_code, 200)

        r = self.c.post(self.api(slug, "git/pull/"), {}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["conflicts"], [])
        content = self.c.get(self.api(slug, "file/"), {"path": "notes/ideas.md"}).data["content"]
        self.assertIn("from colleague", content)
        st = self.c.get(self.api(slug, "git/status/")).data
        self.assertEqual((st["ahead"], st["behind"], st["upstream"]), (0, 0, "origin/main"))


class ReferenceTests(BaseTest):
    BIB = "@book{smith2020,\n  title={A Book},\n  author={Smith, John},\n  year={2020}\n}\n"

    def test_add_list_delete(self):
        slug = self.create()
        r = self.c.post(self.api(slug, "references/"), {"bibtex": self.BIB}, format="json")
        self.assertEqual(r.data["keys"], ["smith2020"])
        refs = self.c.get(self.api(slug, "references/")).data
        self.assertEqual(refs[0]["author"], "Smith, John")
        r = self.c.post(self.api(slug, "references/"), {"bibtex": self.BIB}, format="json")
        self.assertEqual(r.status_code, 400)
        self.c.delete(self.api(slug, "references/smith2020/"))
        self.assertEqual(self.c.get(self.api(slug, "references/")).data, [])

    def test_cite_markup(self):
        slug = self.create()
        self.assertEqual(self.c.get(self.api(slug, "cite/"), {"keys": "a,b", "fmt": "latex"}).data["markup"],
                         "\\cite{a,b}")
        self.assertEqual(self.c.get(self.api(slug, "cite/"), {"keys": "a", "fmt": "markdown"}).data["markup"],
                         "[@a]")


class SearchStatsTests(BaseTest):
    def test_search_and_word_count(self):
        slug = self.create()
        self.c.put(self.api(slug, "file/?path=manuscript/01-introduction.md"),
                   {"content": "# Intro\n\nThe quick brown fox.\n"}, format="json")
        hits = self.c.get(self.api(slug, "search/"), {"q": "BROWN"}).data
        self.assertEqual(hits[0]["path"], "manuscript/01-introduction.md")
        self.assertEqual(self.c.get(self.api(slug, "stats/")).data["total_words"], 5)


@__import__("unittest").skipUnless(pandoc.available(), "pandoc not installed")
class PandocTests(BaseTest):
    def test_mixed_format_export_with_citations(self):
        slug = self.create()
        self.c.post(self.api(slug, "references/"), {"bibtex": ReferenceTests.BIB}, format="json")
        self.c.put(self.api(slug, "file/?path=manuscript/01-introduction.md"),
                   {"content": "# Intro\n\nMarkdown cites [@smith2020].\n"}, format="json")
        self.c.post(self.api(slug, "file/"), {"path": "manuscript/02-latex.tex", "add_to_manuscript": True,
                                              "content": "\\section{Latex}\nSee \\cite{smith2020}.\n"}, format="json")
        self.c.post(self.api(slug, "file/"), {"path": "manuscript/03-rich.html", "add_to_manuscript": True,
                                              "content": '<h1>Rich</h1><p>Rich <span class="citation" '
                                                         'data-cites="smith2020">[@smith2020]</span>.</p>'},
                    format="json")
        r = self.c.post(self.api(slug, "export/"), {"format": "html"}, format="json")
        self.assertEqual(r.status_code, 200)
        text = b"".join(r.streaming_content).decode()
        for heading in ("Intro", "Latex", "Rich"):
            self.assertIn(heading, text)
        self.assertEqual(" ".join(text.split()).count("(Smith 2020)"), 3)
        self.assertNotIn("@smith2020", text)

        r = self.c.post(self.api(slug, "export/"), {"format": "docx"}, format="json")
        self.assertEqual(r.status_code, 200)

    def test_preview_rewrites_images(self):
        slug = self.create()
        r = self.c.post(self.api(slug, "preview/"), {"path": "manuscript/01-introduction.md",
                                                     "content": "![fig](../attachments/a.png)\n\n$x^2$"},
                        format="json")
        self.assertIn(f"/api/projects/{slug}/raw/?path=attachments/a.png", r.data["html"])
        self.assertIn("<math", r.data["html"])
