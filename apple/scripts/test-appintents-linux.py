#!/usr/bin/env python3
"""Synthetic unit tests of the read-only auditor, not iOS discovery tests."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-appintents-linux.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def constants():
    return [{"typeName": "App.Task", "mangledTypeName": "3App4TaskV", "conformances": ["AppIntents.AppIntent"],
             "properties": [{"label": "authenticationPolicy", "value": {"name": "requiresLocalDeviceAuthentication"}},
                            {"label": "_agent", "type": "AppIntents.IntentParameter<App.Agent>"},
                            {"label": "$agent", "type": "AppIntents.IntentParameter<App.Agent>"}]},
            {"typeName": "App.Agent", "conformances": ["AppIntents.AppEntity"]},
            {"typeName": "App.Query", "conformances": ["AppIntents.EntityQuery"]},
            {"typeName": "App.Shortcuts", "conformances": ["AppIntents.AppShortcutsProvider"],
             "properties": [{"label": "appShortcuts", "value": {"members": [
                 {"element": {"value": {"type": "AppIntents.AppShortcut", "arguments": [{"label": "intent", "type": "App.Task"}]}}},
                 {"element": {"value": {"type": "AppIntents.AppShortcut", "arguments": [{"label": "intent", "type": "App.Other"}]}}}]}}]}]


class AuditTests(unittest.TestCase):
    def test_constants_requirements(self):
        expected = audit.requirements(constants())
        self.assertEqual(len(expected["providers"]["App.Shortcuts"]["shortcuts"]), 2)
        self.assertIn("App.Query", expected["queries"])
        self.assertEqual(len(expected["actions"]["App.Task"]["parameters"]), 1)
        self.assertEqual(expected["actions"]["App.Task"]["parameters"][0]["type"], "AppIntents.IntentParameter<App.Agent>")

    def test_missing_candidate(self):
        codes = {x["code"] for x in audit.audit_candidate(audit.requirements(constants()), {})["findings"]}
        self.assertEqual(codes, {"missing_action", "missing_auto_shortcut", "missing_entity", "missing_query"})

    def test_placeholder_policy_and_type(self):
        data = {"actions": {"Task": {"mangledTypeName": "incorrect", "isAuthPolExplicit": False,
                                   "parameters": [{"name": "agent", "valueType": {"primitive": {"wrapper": {"typeIdentifier": 0}}}}]}}}
        codes = {x["code"] for x in audit.audit_candidate(audit.requirements(constants()), data)["findings"]}
        self.assertTrue({"mangled_type_mismatch", "explicit_authentication_policy_not_preserved", "unverified_generic_parameter_type"}.issubset(codes))

    def test_no_findings_does_not_prove_discovery(self):
        report = audit.audit_candidate(audit.requirements([]), {})
        self.assertEqual(report["findings"], [])
        self.assertFalse(report["schemaCompatibilityVerified"])
        self.assertFalse(report["phoneDiscoveryVerified"])

    def test_bundle_metadata_exact_parent(self):
        with tempfile.TemporaryDirectory() as folder:
            ipa = Path(folder) / "fixture.ipa"
            with zipfile.ZipFile(ipa, "w") as z:
                for bundle in ["Payload/App.app", "Payload/App.app/PlugIns/Widget.appex"]:
                    z.writestr(bundle + "/Info.plist", plistlib.dumps({"CFBundleIdentifier": bundle}))
                z.writestr("Payload/App.app/Metadata.appintents/extract.actionsdata", "{}")
                z.writestr("Payload/App.app/Metadata.appintents/version.json", "{}")
            report = audit.inspect_ipa(ipa)
            self.assertEqual([b["hasMetadataPair"] for b in report["bundles"]], [True, False])
            self.assertFalse(report["phoneDiscoveryVerified"])

    def test_bad_constants(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "constants.json"
            path.write_text(json.dumps({"wrong": []}))
            with self.assertRaises(ValueError):
                audit.load_constants(path)

    def test_explicit_auth_flag_not_numeric_guess(self):
        data = {"actions": {"Task": {"mangledTypeName": "3App4TaskV", "isAuthPolExplicit": True}}}
        codes = {x["code"] for x in audit.audit_candidate(audit.requirements(constants()), data)["findings"]}
        self.assertNotIn("explicit_authentication_policy_not_preserved", codes)
        self.assertIn("missing_parameter", codes)


if __name__ == "__main__":
    unittest.main()
