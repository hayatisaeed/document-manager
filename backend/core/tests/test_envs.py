"""Python environments, package sources (mirrors) and background jobs."""
import json
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from django.test import override_settings

from core.services import envs, jobs, kernels, packaging

from .test_api import BaseTest


def make_venv(path: Path) -> Path:
    """A minimal virtual environment (no pip: fast and offline)."""
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(path)], check=True)
    return path


def wait(job_id: str, client) -> dict:
    deadline = time.time() + 60
    since, lines = 0, []
    while time.time() < deadline:
        r = client.get(f"/api/jobs/{job_id}/?since={since}").data
        lines += r["lines"]
        since = r["next"]
        if r["state"] != "running":
            return {**r, "lines": lines}
        time.sleep(0.05)
    raise AssertionError("job did not finish")


class EnvBaseTest(BaseTest):
    def setUp(self):
        super().setUp()
        self.envs_dir = self.tmp / "envs"
        self.env_override = override_settings(ENVS_DIR=self.envs_dir, PACKAGE_DEFAULTS="")
        self.env_override.enable()
        # Tests must not depend on a conda installed on this computer.
        self.no_conda = mock.patch.object(envs, "_conda_candidates", return_value=[])
        self.no_conda.start()
        envs._conda_cache["time"] = 0

    def tearDown(self):
        self.no_conda.stop()
        envs._conda_cache["time"] = 0
        self.env_override.disable()
        super().tearDown()


class PackageSourceTests(EnvBaseTest):
    def test_defaults_leave_pip_and_conda_configuration_alone(self):
        env = packaging.pip_env(packaging.get_config())
        self.assertNotIn("PIP_INDEX_URL", env)
        self.assertEqual(packaging.conda_channel_args(), [])

    def test_save_and_apply_mirrors_and_proxy(self):
        r = self.c.put("/api/package-sources/", {"config": {
            "pip_index_url": "https://mirror-pypi.runflare.com/simple/",
            "pip_extra_index_urls": "http://10.0.0.5/simple https://pypi.org/simple",
            "conda_channels": ["https://mirror.kargadan.ir/repository/conda-forge-proxy", "bioconda"],
            "https_proxy": "http://127.0.0.1:8080",
            "no_proxy": "localhost, 127.0.0.1",
        }}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        config = r.data["config"]
        self.assertEqual(config["pip_index_url"], "https://mirror-pypi.runflare.com/simple")
        env = packaging.command_env()
        self.assertEqual(env["PIP_INDEX_URL"], "https://mirror-pypi.runflare.com/simple")
        self.assertEqual(env["PIP_EXTRA_INDEX_URL"], "http://10.0.0.5/simple https://pypi.org/simple")
        self.assertEqual(env["PIP_TRUSTED_HOST"], "10.0.0.5")  # plain-http mirror
        self.assertEqual(env["HTTPS_PROXY"], "http://127.0.0.1:8080")
        self.assertEqual(env["no_proxy"], "localhost,127.0.0.1")
        self.assertEqual(packaging.conda_channel_args(), [
            "--override-channels", "-c", "https://mirror.kargadan.ir/repository/conda-forge-proxy", "-c", "bioconda"])

    def test_presets_include_iranian_and_chinese_mirrors(self):
        presets = self.c.get("/api/package-sources/").data["presets"]
        iran = [p for p in presets["pip"] if p["region"] == "iran"]
        self.assertGreaterEqual(len(iran), 7)
        self.assertTrue(any(p["region"] == "china" for p in presets["pip"]))
        self.assertTrue(any(p["region"] == "iran" for p in presets["conda"]))
        for p in presets["pip"] + presets["conda"]:
            self.assertTrue(p["url"].startswith("https://"), p)

    def test_invalid_url_rejected(self):
        r = self.c.put("/api/package-sources/", {"config": {"pip_index_url": "mirror.example"}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_installer_defaults_used_until_changed(self):
        with override_settings(PACKAGE_DEFAULTS=json.dumps({"pip_index_url": "https://package-mirror.liara.ir/repository/pypi/simple"})):
            self.assertEqual(packaging.get_config()["pip_index_url"], "https://package-mirror.liara.ir/repository/pypi/simple")

    def _fake_response(self, body: str, ctype: str):
        resp = mock.MagicMock()
        resp.__enter__.return_value = resp
        resp.read.return_value = body.encode()
        resp.headers = {"Content-Type": ctype}
        resp.status = 200
        return resp

    def test_lookup_reads_html_simple_index(self):
        page = ('<a href="../../packages/six-1.16.0-py2.py3-none-any.whl#sha256=1">six-1.16.0-py2.py3-none-any.whl</a>'
                '<a href="six-1.17.0.tar.gz">six-1.17.0.tar.gz</a><a href="sixer-9.0.tar.gz">sixer-9.0.tar.gz</a>')
        opener = mock.MagicMock()
        opener.open.return_value = self._fake_response(page, "text/html")
        with mock.patch.object(packaging, "_opener", return_value=opener):
            r = self.c.get("/api/packages/lookup/?name=six").data
        self.assertEqual(r["results"], [{"name": "six", "versions": ["1.17.0", "1.16.0"]}])

    def test_lookup_reads_json_simple_index(self):
        opener = mock.MagicMock()
        opener.open.return_value = self._fake_response(json.dumps({"versions": ["1.9", "1.10"], "files": []}),
                                                       "application/vnd.pypi.simple.v1+json")
        with mock.patch.object(packaging, "_opener", return_value=opener):
            r = packaging.lookup_pip("Some_Pkg")
        self.assertEqual(r["versions"], ["1.10", "1.9"])
        self.assertTrue(opener.open.call_args[0][0].full_url.endswith("/some-pkg/"))

    def test_speed_test_reports_failure(self):
        opener = mock.MagicMock()
        opener.open.side_effect = OSError("unreachable")
        with mock.patch.object(packaging, "_opener", return_value=opener):
            r = self.c.post("/api/package-sources/test/", {"kind": "pip", "url": "https://pypi.org/simple"}, format="json").data
        self.assertFalse(r["ok"])
        self.assertIn("unreachable", r["error"])


class EnvironmentTests(EnvBaseTest):
    def test_app_environment_is_listed_first(self):
        data = self.c.get("/api/envs/").data
        self.assertIsNone(data["conda"])
        first = data["envs"][0]
        self.assertTrue(first["is_app"])
        self.assertEqual(first["path"], str(Path(sys.prefix).resolve()))
        self.assertEqual(first["kernel"], envs.kernel_name(sys.prefix))

    def test_add_existing_venv_by_folder_or_python(self):
        venv = make_venv(self.tmp / "my env")
        r = self.c.post("/api/envs/register/", {"path": str(envs.python_in(venv))}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["path"], str(venv.resolve()))
        self.assertEqual(r.data["kind"], "venv")
        self.assertFalse(r.data["has_ipykernel"])
        self.assertTrue(r.data["python_version"].startswith(f"{sys.version_info[0]}.{sys.version_info[1]}"))
        ids = [e["id"] for e in self.c.get("/api/envs/").data["envs"]]
        self.assertIn(r.data["id"], ids)
        bad = self.c.post("/api/envs/register/", {"path": str(self.tmp)}, format="json")
        self.assertEqual(bad.status_code, 422)

    def test_venvs_in_the_app_folder_are_found_and_can_be_deleted(self):
        venv = make_venv(self.envs_dir / "analysis")
        env = next(e for e in self.c.get("/api/envs/").data["envs"] if e["name"] == "analysis")
        self.assertTrue(env["created_by_app"])
        r = self.c.delete(f"/api/envs/{env['id']}/?delete_files=true")
        self.assertEqual(r.status_code, 204)
        self.assertFalse(venv.exists())

    def test_removing_from_list_keeps_files(self):
        venv = make_venv(self.tmp / "external")
        env = self.c.post("/api/envs/register/", {"path": str(venv)}, format="json").data
        self.assertEqual(self.c.delete(f"/api/envs/{env['id']}/").status_code, 204)
        self.assertTrue(venv.exists())
        self.assertNotIn(env["id"], [e["id"] for e in self.c.get("/api/envs/").data["envs"]])

    def test_app_environment_cannot_be_deleted(self):
        app = envs.app_env()
        r = self.c.delete(f"/api/envs/{app['id']}/?delete_files=true")
        self.assertEqual(r.status_code, 422)

    def test_package_specs_cannot_be_options(self):
        app = envs.app_env()
        for bad in (["--index-url=http://evil"], ["numpy; rm -rf /"], []):
            r = self.c.post(f"/api/envs/{app['id']}/packages/", {"packages": bad}, format="json")
            self.assertEqual(r.status_code, 422, bad)

    def test_lists_packages_of_app_environment(self):
        app = envs.app_env()
        packages = {p["name"].lower(): p for p in self.c.get(f"/api/envs/{app['id']}/packages/").data["packages"]}
        self.assertIn("django", packages)
        self.assertEqual(packages["django"]["manager"], "pip")

    def test_create_venv_requires_valid_unique_name(self):
        self.assertEqual(self.c.post("/api/envs/create/", {"kind": "venv", "name": "has space"}, format="json").status_code, 422)
        make_venv(self.envs_dir / "taken")
        self.assertEqual(self.c.post("/api/envs/create/", {"kind": "venv", "name": "taken"}, format="json").status_code, 422)
        r = self.c.post("/api/envs/create/", {"kind": "conda", "name": "x"}, format="json")
        self.assertEqual(r.status_code, 422)
        self.assertIn("conda", r.data["detail"])


class ProjectEnvironmentTests(EnvBaseTest):
    def setUp(self):
        super().setUp()
        self.slug = self.create()
        nb = self.projects / self.slug / "nb.ipynb"
        nb.write_text(json.dumps({"cells": [], "metadata": {}, "nbformat": 4, "nbformat_minor": 5}))

    def status(self):
        return self.c.get(self.api(self.slug, "kernel/status/") + "?path=nb.ipynb").data

    def test_kernel_choice_notebook_then_project_then_app(self):
        app = envs.app_env()
        self.assertEqual((self.status()["selected"], self.status()["selected_source"]), (app["kernel"], "app"))
        venv = self.c.post("/api/envs/register/", {"path": str(make_venv(self.tmp / "proj"))}, format="json").data
        r = self.c.put(self.api(self.slug, "env/"), {"env_id": venv["id"]}, format="json").data
        self.assertEqual(r["env"]["id"], venv["id"])
        self.assertEqual((self.status()["selected"], self.status()["selected_source"]), (venv["kernel"], "project"))
        # The environment has no ipykernel: starting is refused with a code the UI acts on.
        r = self.c.post(self.api(self.slug, "kernel/start/"), {"path": "nb.ipynb"}, format="json")
        self.assertEqual(r.status_code, 422)
        self.assertEqual((r.data["code"], r.data["env"]), ("missing_ipykernel", venv["id"]))
        # Clearing the project environment goes back to the app's.
        self.c.put(self.api(self.slug, "env/"), {"env_id": None}, format="json")
        self.assertEqual(self.status()["selected_source"], "app")

    @unittest.skipUnless(kernels.available(), "no Jupyter kernel installed")
    def test_notebook_choice_is_remembered_and_cleared(self):
        app = envs.app_env()
        r = self.c.post(self.api(self.slug, "kernel/start/"), {"path": "nb.ipynb", "kernel": app["kernel"]}, format="json")
        try:
            self.assertEqual(r.status_code, 200, r.data)
            self.assertEqual((r.data["kernel"], r.data["selected_source"]), (app["kernel"], "notebook"))
            out = self.c.post(self.api(self.slug, "kernel/execute/"),
                              {"path": "nb.ipynb", "code": "import sys; print(sys.prefix)"}, format="json").data
            self.assertEqual(Path(out["outputs"][0]["text"].strip()).resolve(), Path(sys.prefix).resolve())
            r = self.c.post(self.api(self.slug, "kernel/restart/"), {"path": "nb.ipynb"}, format="json")
            self.assertEqual(r.data["kernel"], app["kernel"])
            r = self.c.post(self.api(self.slug, "kernel/start/"), {"path": "nb.ipynb", "kernel": ""}, format="json")
            self.assertEqual(r.data["selected_source"], "app")
        finally:
            self.c.post(self.api(self.slug, "kernel/shutdown/"), {"path": "nb.ipynb"}, format="json")

    def test_export_requirements_for_venv(self):
        app = envs.app_env()
        r = self.c.post(self.api(self.slug, "env/export/"), {"env_id": app["id"]}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["file"], "requirements.txt")
        self.assertTrue(r.data["files"]["requirements"])
        text = (self.projects / self.slug / "requirements.txt").read_text()
        self.assertRegex(text, r"(?im)^django==")

    def test_export_without_environment_is_refused(self):
        r = self.c.post(self.api(self.slug, "env/export/"), {}, format="json")
        self.assertEqual(r.status_code, 422)

    def test_create_from_missing_file_is_refused(self):
        r = self.c.post(self.api(self.slug, "env/create/"), {"kind": "venv", "name": "x"}, format="json")
        self.assertEqual(r.status_code, 422)


class EnvironmentFileTests(EnvBaseTest):
    def test_round_trip_and_mirror_rewrite(self):
        path = self.tmp / "environment.yml"
        envs.write_environment_yml(path, "book", ["conda-forge"], ["python=3.12", "numpy>=2"], ["requests==2.32.3"])
        text = path.read_text()
        self.assertIn("  - numpy>=2\n", text)
        self.assertIn("  - pip:\n      - requests==2.32.3", text)
        data = envs._parse_environment_yml(text)
        self.assertEqual(data["channels"], ["conda-forge"])
        self.assertEqual(data["dependencies"], ["python=3.12", "numpy>=2", "pip"])
        self.assertEqual(data["pip"], ["requests==2.32.3"])
        packaging.save_config({"conda_channels": ["https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"]})
        rewritten = Path(envs._rewrite_environment_file(path))
        try:
            data = envs._parse_environment_yml(rewritten.read_text())
        finally:
            rewritten.unlink()
        self.assertEqual(data["channels"], ["https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge"])
        self.assertIn("ipykernel", data["dependencies"])
        self.assertEqual(data["pip"], ["requests==2.32.3"])

    def test_mirror_urls_exported_as_channel_names(self):
        self.assertEqual(envs._channel_name("https://mirror.kargadan.ir/repository/conda-forge-proxy"), "conda-forge")
        self.assertEqual(envs._channel_name("https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main"), "defaults")
        self.assertEqual(envs._channel_name("bioconda"), "bioconda")

    def test_parses_files_written_by_conda(self):
        text = "name: x\nchannels:\n- conda-forge\ndependencies:\n- python=3.11\n- pip:\n  - rich==13.0\n- numpy\nprefix: /opt/x\n"
        data = envs._parse_environment_yml(text)
        self.assertEqual(data["dependencies"], ["python=3.11", "numpy"])
        self.assertEqual(data["pip"], ["rich==13.0"])


class JobTests(EnvBaseTest):
    def run_job(self, code: str) -> dict:
        job = jobs.start(jobs.Job("test", [[sys.executable, "-c", code]]))
        return wait(job.id, self.c)

    def test_output_and_success(self):
        r = self.run_job("import sys\nfor i in range(3): print('line', i)\nsys.stdout.write('50%\\r100%\\n')")
        self.assertEqual(r["state"], "succeeded")
        self.assertIn("line 2", r["lines"])
        self.assertIn("100%", r["lines"])

    def test_failure_is_reported(self):
        r = self.run_job("raise SystemExit(3)")
        self.assertEqual(r["state"], "failed")
        self.assertIn("code 3", r["error"])

    def test_cancel(self):
        job = jobs.start(jobs.Job("sleep", [[sys.executable, "-c", "import time; print('go', flush=True); time.sleep(30)"]]))
        time.sleep(0.5)
        self.c.post(f"/api/jobs/{job.id}/cancel/")
        self.assertEqual(wait(job.id, self.c)["state"], "cancelled")

    def test_unknown_job(self):
        self.assertEqual(self.c.get("/api/jobs/nope/").status_code, 404)
