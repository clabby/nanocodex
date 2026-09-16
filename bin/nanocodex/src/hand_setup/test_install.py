"""Policy tests for the actual installer, without mutating the host."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hand_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def stage_template(self, stage):
        image = Path(__file__).resolve().parents[4] / "crates/nanocodex-vm/image"
        for name in ["Dockerfile", "Dockerfile.ext4", "populate-ext4.sh", "build-root.sh", "toolkit"]:
            source = image / name
            if source.is_dir():
                shutil.copytree(source, stage / name)
            else:
                shutil.copyfile(source, stage / name)
        for name in ["Cargo.toml", "Cargo.lock", "src/main.rs", "extensions/helper.js"]:
            path = stage / "computer-source" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)

    def test_computer_source_changes_invalidate_cached_image(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            self.stage_template(stage)
            original = installer.template_key(stage)
            helper = stage / "computer-source/extensions/helper.js"
            helper.write_text("updated")
            edited = installer.template_key(stage)
            self.assertNotEqual(original, edited)
            helper.rename(helper.with_name("renamed.js"))
            renamed = installer.template_key(stage)
            self.assertNotEqual(edited, renamed)
            helper.with_name("renamed.js").unlink()
            self.assertNotEqual(renamed, installer.template_key(stage))

    def test_image_build_receives_bundled_context_and_rerun_reuses_image(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            self.stage_template(stage)
            (stage / "images").mkdir()
            with patch.object(installer, "ROOT", stage), patch.object(installer, "run") as run:
                template = installer.prepare_template(stage)
                build = next(call.args for call in run.call_args_list if call.args[:2] == ("docker", "build"))
                self.assertEqual(build[build.index("--build-context") + 1], f"computer-source={stage / 'computer-source'}")
                template.touch()
                run.reset_mock()
                self.assertEqual(installer.prepare_template(stage), template)
                run.assert_not_called()
                (stage / "computer-source/src/main.rs").unlink()
                with self.assertRaisesRegex(RuntimeError, "Missing bundled"):
                    installer.prepare_template(stage)
                run.assert_not_called()

    def test_account_check_uses_identified_client_and_auth_header(self):
        with patch.object(installer.urllib.request, "urlopen", return_value=contextlib.closing(io.BytesIO(b'{"data": []}'))) as request:
            self.assertEqual(installer.account_get({"origin": "https://example.invalid", "credential": "synthetic"}, "/v1/account/hands"), {"data": []})
        sent = request.call_args.args[0]
        self.assertEqual(sent.get_header("User-agent"), "nanocodex-hand-setup")
        self.assertEqual(sent.get_header("Authorization"), "Bearer synthetic")
        self.assertNotIn("synthetic", sent.full_url)

    def test_bad_download_never_replaces_a_cached_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            expected = hashlib.sha256(b"expected").hexdigest()
            with patch.object(installer.urllib.request, "urlopen", return_value=contextlib.closing(io.BytesIO(b"wrong"))):
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    installer.download("https://example.invalid/asset", expected, cache)
            self.assertEqual(list(cache.iterdir()), [])

    def test_verified_cached_artifact_avoids_network(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            expected = hashlib.sha256(b"expected").hexdigest()
            (cache / expected).write_bytes(b"expected")
            with patch.object(installer.urllib.request, "urlopen", side_effect=AssertionError("network")):
                self.assertEqual(installer.download("https://example.invalid/asset", expected, cache), cache / expected)

    def test_credentials_stay_private_on_unchanged_reruns_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "account.env"
            installer.atomic(path, b"synthetic-secret", 0o600)
            os.chmod(path, 0o644)
            self.assertFalse(installer.atomic(path, b"synthetic-secret", 0o600))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            linked = Path(directory) / "linked"
            linked.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, "unexpected file"):
                installer.atomic(linked, b"replacement")
            self.assertEqual(path.read_bytes(), b"synthetic-secret")

    def test_service_waits_for_application_readiness_and_keeps_credentials_out_of_argv(self):
        service = installer.unit("hand --workspace /srv/nanocodex/workspace").decode()
        self.assertIn("Type=notify\n", service)
        self.assertIn("NotifyAccess=main\n", service)
        self.assertIn("EnvironmentFile=/opt/nanocodex/account.env\n", service)
        self.assertNotIn("NANOCODEX_API_KEY=", service)


if __name__ == "__main__":
    unittest.main()
