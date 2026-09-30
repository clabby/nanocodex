#!/usr/bin/env python3
"""Offline contract/real-compiler-fixture tests. No Apple/device compatibility claim."""
import base64
import copy
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("processor", Path(__file__).with_name("appintents-linux.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
FIXTURES = Path(__file__).resolve().parents[1] / "xtool" / "appintents-fixtures"


def compiler(module="NanocodexInbox"):
    filename = "inbox.swiftconstvalues.json" if module == "NanocodexInbox" else "widgets.swiftconstvalues.json"
    return p.read_json(FIXTURES / filename)


def synthetic_reference(ir):
    """Mock container contract, NOT an Apple-generated schema fixture.

    String sentinels are intentional: these tests must not pretend they know
    numeric Apple type/mode/policy codes. Replay treats payloads as opaque bytes.
    """
    data = {"actions": {}, "entities": {}, "queries": {}, "autoShortcuts": []}
    for category in ("actions", "entities", "queries"):
        for name, fact in ir["requirements"][category].items():
            out = {"mangledTypeName": fact["mangledTypeName"]}
            if category == "actions":
                out["parameters"] = [{"name": x["name"], "valueType": {"TEST_ONLY_NOT_APPLE": x["valueType"]["swiftType"]}}
                                     for x in fact["parameters"]]
                out["authenticationPolicy"] = "TEST_ONLY_NOT_APPLE"
                out["isAuthPolExplicit"] = "status" not in fact["authenticationPolicy"]
                out["supportedModes"] = "TEST_ONLY_NOT_APPLE"
            data[category][name.rsplit('.', 1)[-1]] = out
    for provider in ir["requirements"]["providers"].values():
        data["autoShortcutProviderMangledName"] = provider["mangledTypeName"]
        for shortcut in provider["shortcuts"]:
            data["autoShortcuts"].append({"actionIdentifier": shortcut["actionType"].rsplit('.', 1)[-1]})
    return data


CONTEXT = {"sdkBuild": "TEST-ONLY", "swiftCompilerVersion": "TEST-ONLY", "targetTriple": "TEST-ONLY",
           "bundleIdentifier": "TEST-ONLY", "buildMode": "TEST-ONLY"}
PROVENANCE = {"primaryTool": "appintentsmetadataprocessor", "captureDescription": "synthetic unit contract; not Apple output",
              "captureEvidence": "test-appintents-processor-linux.py; NOT a primary reference"}


class ProcessorTests(unittest.TestCase):
    def setUp(self):
        self.decls = compiler()
        self.ir = p.analyze("NanocodexInbox", self.decls)

    def changed(self, suffix, label):
        d = next(x for x in self.decls if x["typeName"].endswith("." + suffix))
        return next(x for x in d["properties"] if x["label"] == label)

    def make_profile(self):
        self.sources = {"mock.swift": hashlib.sha256(b"TEST-ONLY-SOURCE").hexdigest()}
        self.actions = json.dumps(synthetic_reference(self.ir), indent=2).encode() + b"\n"
        self.version = b'{"version":"TEST_ONLY_NOT_APPLE"}\n'
        sidecars = {"nlu/TEST_ONLY.fixture": b"TEST_ONLY_NOT_APPLE"}
        self.binding = {"sourceManifest": self.sources, "buildContext": CONTEXT, "compilerSemanticSHA256": self.ir["compilerSemanticSHA256"],
                        "metadataSHA256": {name: hashlib.sha256(data).hexdigest() for name, data in {"extract.actionsdata": self.actions, "version.json": self.version, **sidecars}.items()}}
        self.profile = p.make_reference(self.ir, self.sources, CONTEXT, self.actions, self.version, PROVENANCE, sidecars, self.binding)
        return self.profile

    def test_actual_inbox_preserves_full_semantic_input(self):
        req = self.ir["requirements"]
        self.assertEqual({k: len(v) for k,v in req.items()}, {"actions": 12, "entities": 1, "queries": 1, "providers": 1})
        self.assertEqual(sum(len(a["parameters"]) for a in req["actions"].values()), 19)
        self.assertEqual(len(req["providers"]["NanocodexInbox.ContextShortcuts"]["shortcuts"]), 7)
        self.assertEqual(self.ir["compilerDeclarations"], sorted(p.sanitize(self.decls), key=lambda d:d["typeName"]))
        self.assertFalse(self.ir["phoneDiscoveryVerified"])
        self.assertFalse(self.ir["appleSchemaSynthesized"])

    def test_actual_widgets_preserves_all_five_actions(self):
        ir = p.analyze("NanocodexWidgets", compiler("NanocodexWidgets"))
        self.assertEqual(len(ir["requirements"]["actions"]), 5)
        self.assertEqual(sum(len(a["parameters"]) for a in ir["requirements"]["actions"].values()), 3)

    def test_entity_and_query_linkage(self):
        self.assertEqual(self.ir["requirements"]["entities"]["NanocodexInbox.HandAgentEntity"]["defaultQueryType"], "NanocodexInbox.HandAgentQuery")
        self.assertEqual(self.ir["requirements"]["queries"]["NanocodexInbox.HandAgentQuery"]["entityType"], "NanocodexInbox.HandAgentEntity")

    def test_typed_optional_url_date_file_entity(self):
        actions = self.ir["requirements"]["actions"]
        params = {x["name"]:x["valueType"] for x in actions["NanocodexInbox.CaptureContextIntent"]["parameters"]}
        for name,type_name in [("link", "Foundation.URL"), ("date", "Foundation.Date")]:
            self.assertTrue(params[name]["isOptional"])
            self.assertEqual(params[name]["unwrappedSwiftType"],type_name)
        self.assertEqual(actions["NanocodexInbox.CaptureFileContextIntent"]["parameters"][0]["valueType"]["swiftType"], "AppIntents.IntentFile")
        self.assertEqual(actions["NanocodexInbox.RunAgentTaskIntent"]["parameters"][0]["valueType"]["kind"], "entity")

    def test_authentication_and_modes_never_numeric_guesses(self):
        actions = self.ir["requirements"]["actions"]
        self.assertEqual(actions["NanocodexInbox.StartLockedVoiceIntent"]["authenticationPolicy"]["value"], {"name": "requiresLocalDeviceAuthentication"})
        modes = actions["NanocodexInbox.RunAgentTaskIntent"]["supportedModes"]["value"]
        self.assertEqual(modes[0]["value"]["memberLabel"], "background")
        self.assertEqual(modes[1]["value"]["arguments"][0]["value"]["memberLabel"], "dynamic")

    def test_default_and_explicit_wrapper_arguments_preserved(self):
        action = self.ir["requirements"]["actions"]["NanocodexInbox.CaptureContextIntent"]
        source = next(x for x in action["parameters"] if x["name"] == "source")
        self.assertEqual(p.args_of(source["initializer"])["default"]["value"], "Shared")
        self.assertTrue(source["explicitWrapperArguments"])

    def test_localized_unicode_not_normalized_or_lost(self):
        prop = self.changed("StartLockedVoiceIntent", "title")
        prop["value"] = "Ελληνικά 🌍"
        ir = p.analyze("NanocodexInbox", self.decls)
        title = next(x for x in ir["requirements"]["actions"]["NanocodexInbox.StartLockedVoiceIntent"]["properties"] if x["label"] == "title")
        self.assertEqual(title["value"], "Ελληνικά 🌍")
        self.assertNotEqual(ir["compilerSemanticSHA256"], self.ir["compilerSemanticSHA256"])

    def test_source_paths_and_line_locations_do_not_change_fingerprint(self):
        self.decls[0]["file"] = "/different/root.swift"
        self.decls[0]["line"] = 999
        self.decls[0]["properties"][0]["file"] = "/different/root.swift"
        self.assertEqual(p.analyze("NanocodexInbox", self.decls)["compilerSemanticSHA256"], self.ir["compilerSemanticSHA256"])

    def test_all_runtime_nodes_visible(self):
        self.assertEqual(len(self.ir["runtimeUnknowns"]),66)
        self.assertTrue(any("inputConnectionBehavior" == x.get("type", "").rsplit('.',1)[-1] or x.get("type") == "AppIntents.InputConnectionBehavior" for x in self.ir["runtimeUnknowns"]))
        self.assertTrue(any(x.get("type") == "Swift.Array<UniformTypeIdentifiers.UTType>" for x in self.ir["runtimeUnknowns"]))

    def test_unknown_ast_kind_rejected(self):
        self.changed("StartLockedVoiceIntent", "title")["valueKind"] = "ClosureBody"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_unknown_ast_fields_rejected(self):
        self.changed("StartLockedVoiceIntent", "authenticationPolicy")["value"]["newField"] = "unknown"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_array_cannot_silently_accept_raw_elements(self):
        self.changed("RunAgentTaskIntent", "supportedModes")["value"].append("background")
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_conditional_shortcut_builder_rejected(self):
        self.changed("ContextShortcuts", "appShortcuts")["value"]["members"][0]["kind"] = "buildEither"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_unknown_shortcut_target_rejected(self):
        a = self.changed("ContextShortcuts", "appShortcuts")["value"]["members"][0]["element"]["value"]["arguments"][0]
        a["type"] = a["value"]["type"] = "NanocodexInbox.Missing"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_missing_query_rejected(self):
        self.decls = [x for x in self.decls if x["typeName"] != "NanocodexInbox.HandAgentQuery"]
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_parameter_peer_mismatch_rejected(self):
        self.changed("CaptureIMessageIntent", "text")["type"] = "Swift.Int"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_new_parameter_type_rejected(self):
        for label in ("_text", "$text", "text"):
            prop = self.changed("CaptureIMessageIntent", label)
            prop["type"] = "AppIntents.IntentParameter<Swift.Int>" if label != "text" else "Swift.Int"
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_duplicate_declarations_rejected(self):
        self.decls.append(copy.deepcopy(self.decls[0]))
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_module_mismatch_rejected(self):
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexWidgets", self.decls)

    def test_json_duplicate_keys_and_nonfinite_rejected(self):
        for data in [b'{"actions":{},"actions":{}}', b'{"bad":NaN}']:
            with self.assertRaises(p.Unsupported): p.read_json_bytes(data)

    def test_exact_reference_replay_byte_preserving_contract_only(self):
        self.make_profile()
        self.assertEqual(p.replay(self.ir, self.sources, CONTEXT, self.profile), (self.actions,self.version))

    def test_source_changes_rejected_even_when_runtime_ast_identical(self):
        self.make_profile()
        with self.assertRaisesRegex(p.Unsupported,"Runtime"):
            p.replay(self.ir, {"mock.swift":"CHANGED"}, CONTEXT,self.profile)

    def test_any_build_context_change_rejected(self):
        self.make_profile()
        for key in CONTEXT:
            with self.subTest(key=key):
                context = dict(CONTEXT, **{key:"CHANGED"})
                with self.assertRaises(p.Unsupported): p.replay(self.ir,self.sources,context,self.profile)

    def test_semantic_changes_rejected_not_partial_regeneration(self):
        self.make_profile()
        self.changed("StartLockedVoiceIntent", "title")["value"] = "Changed"
        with self.assertRaises(p.Unsupported): p.replay(p.analyze("NanocodexInbox",self.decls),self.sources,CONTEXT,self.profile)

    def test_missing_reference_entry_rejected(self):
        data = synthetic_reference(self.ir)
        del data["actions"]["CaptureContextIntent"]
        with self.assertRaises(p.Unsupported): p.check_coverage(self.ir,data)

    def test_six_lost_shortcuts_detected(self):
        data = synthetic_reference(self.ir)
        data["autoShortcuts"] = data["autoShortcuts"][:1]
        with self.assertRaises(p.Unsupported): p.check_coverage(self.ir,data)

    def test_missing_param_entity_query_auth_and_modes_detected(self):
        for mutation in [lambda d:d["actions"]["RunAgentTaskIntent"]["parameters"].pop(),
                         lambda d:d["entities"].clear(), lambda d:d["queries"].clear(),
                         lambda d:d["actions"]["StartLockedVoiceIntent"].update(isAuthPolExplicit=False),
                         lambda d:d["actions"]["RunAgentTaskIntent"].pop("supportedModes")]:
            data = synthetic_reference(self.ir); mutation(data)
            with self.assertRaises(p.Unsupported):p.check_coverage(self.ir,data)

    def test_payload_tampering_rejected(self):
        self.make_profile()
        self.profile["actionsBase64"] = base64.b64encode(self.actions+b" ").decode()
        with self.assertRaisesRegex(p.Unsupported,"inventory|checksum"):
            p.replay(self.ir,self.sources,CONTEXT,self.profile)

    def test_same_build_mac_compiler_semantics_exactly_match_linux(self):
        for category,module in [('app','NanocodexInbox'),('widgets','NanocodexWidgets')]:
            ds=[]
            for path in sorted((FIXTURES/'mac-compiler-inputs'/category).glob('*.swiftconstvalues')):ds.extend(p.read_json(path))
            self.assertEqual(p.analyze(module,ds)['compilerSemanticSHA256'],p.analyze(module,compiler(module))['compilerSemanticSHA256'])

    def test_actual_ota_main_reference_all_comparable_facts_match(self):
        data=p.read_json(FIXTURES/'ota-main.extract.actionsdata');version=p.read_json(FIXTURES/'ota-main.version.json')
        result=p.compare_reference(self.ir,data,version)
        self.assertTrue(result['allComparableFactsMatch']);self.assertEqual(len(result['checks']),101)
        self.assertFalse(result['pairedReferenceCompilerInputVerified'])
        self.assertFalse(result['schemaNumericSemanticsVerified'])

    def test_actual_ota_widget_reference_all_comparable_facts_match(self):
        ir=p.analyze('NanocodexWidgets',compiler('NanocodexWidgets'))
        result=p.compare_reference(ir,p.read_json(FIXTURES/'ota-widgets.extract.actionsdata'),p.read_json(FIXTURES/'ota-widgets.version.json'))
        self.assertTrue(result['allComparableFactsMatch']);self.assertEqual(len(result['checks']),22)

    def test_actual_ota_reference_mismatch_is_not_silent(self):
        data=p.read_json(FIXTURES/'ota-main.extract.actionsdata');data['actions']['RunAgentTaskIntent']['title']['key']='Wrong'
        result=p.compare_reference(self.ir,data,p.read_json(FIXTURES/'ota-main.version.json'))
        self.assertFalse(result['allComparableFactsMatch'])

    def test_main_pair_only_reference_rejected_to_avoid_nlu_loss(self):
        self.make_profile()
        with self.assertRaisesRegex(p.Unsupported,"NLU"):
            p.make_reference(self.ir,self.sources,CONTEXT,self.actions,self.version,PROVENANCE)

    def test_opaque_sidecars_verified_and_preserved(self):
        self.make_profile()
        self.assertEqual(p.unpack_sidecars(self.profile),{"nlu/TEST_ONLY.fixture": b"TEST_ONLY_NOT_APPLE"})
        self.profile["sidecars"]["nlu/TEST_ONLY.fixture"]["sha256"]="bad"
        with self.assertRaisesRegex(p.Unsupported,"checksum"):p.replay(self.ir,self.sources,CONTEXT,self.profile)

    def test_sidecar_path_traversal_rejected(self):
        self.make_profile()
        self.profile['sidecars']['nlu/../../unexpected'] = self.profile['sidecars'].pop('nlu/TEST_ONLY.fixture')
        with self.assertRaises(p.Unsupported):p.replay(self.ir,self.sources,CONTEXT,self.profile)

    def test_absent_provenance_rejected(self):
        self.make_profile()
        self.profile["provenance"] = {}
        with self.assertRaises(p.Unsupported): p.replay(self.ir,self.sources,CONTEXT,self.profile)

    def test_full_source_manifest_detects_unrelated_swift_file_changes(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root); (path/"a.swift").write_text("a"); (path/"b.swift").write_text("b")
            before=p.source_manifest(path); (path/"b.swift").write_text("c")
            self.assertNotEqual(before,p.source_manifest(path))

    def test_emit_no_profile_fails_before_output(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root); source=root/"Sources"; source.mkdir(); (source/"main.swift").write_text("// synthetic fixture\n")
            decls=copy.deepcopy(self.decls)
            for declaration in decls:declaration["file"]=str(source/"main.swift")
            constants=root/"input.json"; constants.write_text(json.dumps(decls))
            context=root/"context.json"; context.write_text(json.dumps(CONTEXT))
            output=root/"out"
            rc=p.main(["emit","--module","NanocodexInbox","--const-values",str(constants),"--source-root",str(source),"--context",str(context),"--output",str(output)])
            self.assertEqual(rc,1);self.assertFalse(output.exists())

    def test_cli_will_not_overwrite_existing_analysis(self):
        with tempfile.TemporaryDirectory() as root:
            output=Path(root)/"out"; output.write_text("owned-by-other-agent")
            rc=p.main(["analyze","--module","NanocodexInbox","--const-values",str(FIXTURES/"inbox.swiftconstvalues.json"),"--output",str(output)])
            self.assertEqual(rc,1);self.assertEqual(output.read_text(),"owned-by-other-agent")


    def mac_constants(self, category):
        declarations = []
        for path in sorted((FIXTURES / "mac-compiler-inputs" / category).glob("*.swiftconstvalues")):
            declarations.extend(p.read_json(path))
        return declarations

    def test_recovered_actual_mac_metadata_comparison_and_calibration(self):
        for category, module, checks in [("app", "NanocodexInbox", 101), ("widgets", "NanocodexWidgets", 22)]:
            with self.subTest(module=module):
                ir = p.analyze(module, compiler(module))
                result = p.calibrate(ir, p.analyze(module, self.mac_constants(category)),
                    p.read_json(FIXTURES / "mac-metadata" / category / "extract.actionsdata"),
                    p.read_json(FIXTURES / "mac-metadata" / category / "version.json"), p.read_json(FIXTURES / "mac-paired-provenance.json"))
                self.assertEqual(len(result["checks"]), checks)
                self.assertTrue(result["allComparableFactsMatch"])
                self.assertTrue(result["pairedReferenceCompilerInputVerified"])
                self.assertFalse(result["sameImmutableSourceManifestVerified"])
                self.assertFalse(result["sameSDKCompilerContextVerified"])
                self.assertFalse(result["appleSchemaSynthesized"])
                self.assertNotIn("actionsBase64", result)

    def test_calibration_rejects_changed_compiler_facts(self):
        reference_ir = p.analyze("NanocodexInbox", self.mac_constants("app"))
        self.changed("StartLockedVoiceIntent", "title")["value"] = "Wrong"
        with self.assertRaisesRegex(p.Unsupported, "compiler facts differ"):
            p.calibrate(p.analyze("NanocodexInbox", self.decls), reference_ir, {}, {}, p.read_json(FIXTURES / "mac-paired-provenance.json"))

    def test_calibration_cli_success_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = ["calibrate", "--module", "NanocodexInbox", "--const-values", str(FIXTURES / "inbox.swiftconstvalues.json"),
                    "--actionsdata", str(FIXTURES / "mac-metadata/app/extract.actionsdata"),
                    "--version-json", str(FIXTURES / "mac-metadata/app/version.json")]
            paired = sum((["--reference-const-values", str(path)] for path in sorted((FIXTURES / "mac-compiler-inputs/app").glob("*.swiftconstvalues"))), [])
            output = root / "success.json"
            self.assertEqual(p.main(base + paired + ["--provenance", str(FIXTURES / "mac-paired-provenance.json"), "--output", str(output)]), 0)
            result = p.read_json(output)
            self.assertEqual(result["kind"], "paired-compiler-schema-calibration-evidence")
            self.assertNotIn("/Users/", output.read_text())
            self.assertEqual(p.main(base + ["--output", str(root / "unpaired.json")]), 1)
            self.assertFalse((root / "unpaired.json").exists())
            changed = copy.deepcopy(self.decls)
            changed[0]["mangledTypeName"] += "WRONG"
            constants = root / "changed.json"; constants.write_text(json.dumps(changed))
            self.assertEqual(p.main(base + ["--reference-const-values", str(constants), "--provenance", str(FIXTURES / "mac-paired-provenance.json"), "--output", str(root / "changed-out.json")]), 1)
            self.assertFalse((root / "changed-out.json").exists())
            wrong = root / "wrong-provenance.json"; wrong.write_text("{}")
            self.assertEqual(p.main(base + paired + ["--provenance", str(wrong), "--output", str(root / "bad-provenance-out.json")]), 1)
            self.assertFalse((root / "bad-provenance-out.json").exists())

    def test_calibration_rejects_metadata_mismatch(self):
        data = p.read_json(FIXTURES / "mac-metadata/app/extract.actionsdata")
        data["actions"]["StartLockedVoiceIntent"]["title"]["key"] = "Wrong"
        with self.assertRaisesRegex(p.Unsupported, "literal facts disagree"):
            p.calibrate(self.ir, self.ir, data, p.read_json(FIXTURES / "mac-metadata/app/version.json"), p.read_json(FIXTURES / "mac-paired-provenance.json"))

    def test_fixture_hashes_and_sanitization(self):
        provenance = p.read_json(FIXTURES / "mac-paired-provenance.json")
        self.assertEqual(provenance["envelopeFileCount"], 15)
        self.assertFalse(provenance["sourceSDKContextBound"])
        self.assertFalse(provenance["NLUSidecarsIncluded"])
        for name, item in provenance["files"].items():
            data = (FIXTURES / name).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
            if item["sanitized"]:
                parsed = p.read_json_bytes(data)
                self.assertEqual(p.sanitize(parsed), parsed)
        for path in FIXTURES.rglob("*"):
            if path.is_file():
                text = path.read_text()
                self.assertNotIn("/Users/", text)
                self.assertNotIn("/home/", text)
                self.assertNotIn("/srv/", text)
                self.assertNotIn("nativeWorkspace", text)
                self.assertNotIn("actualWorkspace", text)
                self.assertNotEqual(path.name, "nlu.lzfse")

    def test_empty_or_unsupported_declarations_fail_closed(self):
        for declarations in [[], [{"typeName": "NanocodexInbox.Future", "conformances": ["AppIntents.FutureProtocol"], "mangledTypeName": "TEST_ONLY"}]]:
            with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", declarations)

    def test_malformed_associated_aliases_and_conformances_rejected(self):
        for field, value in [("associatedTypeAliases", {}), ("associatedTypeAliases", ["bad"]), ("conformances", [None])]:
            decls = copy.deepcopy(self.decls); decls[0][field] = value
            with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", decls)

    def test_duplicate_property_and_alias_rejected(self):
        decls = copy.deepcopy(self.decls); decls[0]["properties"].append(copy.deepcopy(decls[0]["properties"][0]))
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", decls)
        decls = copy.deepcopy(self.decls); conflicting = copy.deepcopy(decls[0]["associatedTypeAliases"][0]); conflicting["substitutedTypeName"] += "WRONG"; decls[0]["associatedTypeAliases"].append(conflicting)
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", decls)

    def test_malformed_call_argument_rejected(self):
        prop = self.changed("CaptureContextIntent", "_text")
        prop["value"]["arguments"].append({})
        with self.assertRaisesRegex(p.Unsupported, "malformed call argument"): p.analyze("NanocodexInbox", self.decls)

    def test_multiple_providers_fail_closed_for_reference_merge(self):
        provider = copy.deepcopy(self.ir["requirements"]["providers"]["NanocodexInbox.ContextShortcuts"])
        ir = copy.deepcopy(self.ir); ir["requirements"]["providers"]["NanocodexInbox.Other"] = provider
        with self.assertRaises(p.Unsupported): p.check_coverage(ir, synthetic_reference(ir))

    def test_reference_requires_separately_captured_source_and_context(self):
        self.make_profile()
        for field in ["sourceManifest", "buildContext", "compilerSemanticSHA256", "metadataSHA256"]:
            binding = copy.deepcopy(self.binding); binding.pop(field)
            with self.subTest(field=field), self.assertRaises(p.Unsupported):
                p.make_reference(self.ir, self.sources, CONTEXT, self.actions, self.version, PROVENANCE,
                                 p.unpack_sidecars(self.profile), binding)
        binding = copy.deepcopy(self.binding); binding["sourceManifest"] = {"other.swift": "0" * 64}
        with self.assertRaisesRegex(p.Unsupported, "source manifest differs"):
            p.make_reference(self.ir, self.sources, CONTEXT, self.actions, self.version, PROVENANCE, p.unpack_sidecars(self.profile), binding)
        binding = copy.deepcopy(self.binding); binding["buildContext"]["sdkBuild"] = "DIFFERENT"
        with self.assertRaisesRegex(p.Unsupported, "context differs"):
            p.make_reference(self.ir, self.sources, CONTEXT, self.actions, self.version, PROVENANCE, p.unpack_sidecars(self.profile), binding)

    def test_missing_one_of_multiple_sidecars_is_rejected(self):
        self.make_profile()
        self.binding["metadataSHA256"]["nlu/second.fixture"] = hashlib.sha256(b"MOCK").hexdigest()
        with self.assertRaisesRegex(p.Unsupported, "inventory"):
            p.replay(self.ir, self.sources, CONTEXT, self.profile)

    def test_noncanonical_sidecar_names_rejected(self):
        self.make_profile()
        for name in ["nlu//x", "nlu/./x", "nlu/a/../x", "nlu/x\\y", "nlu/x\x00y", "/nlu/x", "nlu/"]:
            profile = copy.deepcopy(self.profile)
            profile["sidecars"] = {name: self.profile["sidecars"]["nlu/TEST_ONLY.fixture"]}
            with self.subTest(name=name), self.assertRaises(p.Unsupported): p.unpack_sidecars(profile)

    def test_source_manifest_rejects_file_and_directory_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "source"; source.mkdir(); (source / "main.swift").write_text("// TEST_ONLY")
            outside = root / "outside"; outside.mkdir(); (outside / "other.swift").write_text("// TEST_ONLY")
            link = source / "link"; link.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(p.Unsupported, "symlink"): p.source_manifest(source)
            link.unlink(); link.symlink_to(outside / "other.swift")
            with self.assertRaisesRegex(p.Unsupported, "symlink"): p.source_manifest(source)

    def test_reference_profile_v1_rejected(self):
        self.make_profile(); self.profile["format"] = "nanocodex-appintents-exact-reference-v1"
        with self.assertRaisesRegex(p.Unsupported, "reference format"): p.replay(self.ir, self.sources, CONTEXT, self.profile)

    def test_manifest_invalid_paths_and_hashes_rejected(self):
        for manifest in [{}, {"../a.swift": "0" * 64}, {"a.swift": "INVALID"}, {"a.txt": "0" * 64}]:
            with self.assertRaises(p.Unsupported): p.check_manifest(manifest)

    def test_reference_and_emit_cli_container_contract_only(self):
        # Actual Apple widget payload, but source/context are MOCK controls; this
        # proves offline reference/replay contracts, NOT a production source pair.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "source"; source.mkdir(); (source / "main.swift").write_text("// MOCK source, NOT the real paired source\n")
            decls = compiler("NanocodexWidgets")
            for declaration in decls: declaration["file"] = str(source / "main.swift")
            constants = root / "constants.json"; constants.write_text(json.dumps(decls))
            context = root / "context.json"; context.write_text(json.dumps(CONTEXT))
            sources = root / "sources.json"; sources.write_text(json.dumps(p.source_manifest(source)))
            provenance = root / "provenance.json"; provenance.write_text(json.dumps(PROVENANCE))
            metadata = FIXTURES / "mac-metadata/widgets"
            inventory = root / "inventory.json"; inventory.write_text(json.dumps({x.name: hashlib.sha256(x.read_bytes()).hexdigest() for x in metadata.iterdir()}))
            profile = root / "profile.json"; emitted = root / "emitted"
            common = ["--module", "NanocodexWidgets", "--const-values", str(constants), "--source-root", str(source), "--context", str(context)]
            paired = sum((["--reference-const-values", str(path)] for path in sorted((FIXTURES / "mac-compiler-inputs/widgets").glob("*.swiftconstvalues"))), [])
            reference = ["reference"] + common + paired + ["--actionsdata", str(metadata / "extract.actionsdata"), "--version-json", str(metadata / "version.json"), "--provenance", str(provenance)]
            self.assertEqual(p.main(reference + ["--output", str(root / "missing-binding.json")]), 1)
            self.assertFalse((root / "missing-binding.json").exists())
            self.assertEqual(p.main(reference + ["--reference-source-manifest", str(sources), "--reference-context", str(context), "--metadata-inventory", str(inventory), "--output", str(profile)]), 0)
            self.assertEqual(p.main(["emit"] + common + ["--profile", str(profile), "--output", str(emitted)]), 0)
            self.assertEqual({x.name: x.read_bytes() for x in emitted.iterdir()}, {x.name: x.read_bytes() for x in metadata.iterdir()})
            (source / "main.swift").write_text("// CHANGED MOCK SOURCE")
            rejected = root / "source-change-rejected"
            self.assertEqual(p.main(["emit"] + common + ["--profile", str(profile), "--output", str(rejected)]), 1)
            self.assertFalse(rejected.exists())


    def test_summary_nil_table_is_fixture_backed_but_other_tables_fail_closed(self):
        for kind, value in [("RawLiteral", "non-default-table"), ("Runtime", None)]:
            decls = copy.deepcopy(self.decls)
            summary = next(x for d in decls if d["typeName"].endswith(".CaptureWhatsAppIntent") for x in d["properties"] if x["label"] == "parameterSummary")
            table = next(x for x in summary["value"]["arguments"] if x["label"] == "table")
            table["valueKind"] = kind
            if value is not None: table["value"] = value
            with self.subTest(kind=kind), self.assertRaisesRegex(p.Unsupported, "localization table"):
                p.compare_reference(p.analyze("NanocodexInbox", decls), p.read_json(FIXTURES / "mac-metadata/app/extract.actionsdata"), p.read_json(FIXTURES / "mac-metadata/app/version.json"))

    def test_summary_unknown_constructor_and_trailing_arguments_rejected(self):
        for mutation in [lambda call: call["value"].update(type="AppIntents.UnknownSummary"),
                         lambda call: call["value"]["arguments"].append({"label": "unknown", "type": "Swift.String", "valueKind": "RawLiteral", "value": "ignored?"}),
                         lambda call: call["value"]["arguments"].append(copy.deepcopy(call["value"]["arguments"][1]))]:
            decls = copy.deepcopy(self.decls)
            summary = next(x for d in decls if d["typeName"].endswith(".CaptureWhatsAppIntent") for x in d["properties"] if x["label"] == "parameterSummary")
            mutation(summary)
            with self.assertRaises(p.Unsupported):
                p.compare_reference(p.analyze("NanocodexInbox", decls), p.read_json(FIXTURES / "mac-metadata/app/extract.actionsdata"), p.read_json(FIXTURES / "mac-metadata/app/version.json"))

    def test_declaration_validation_rejects_malformed_conformances_before_identity_discovery(self):
        for value in [None, {}, "AppIntents.AppEntity", ["AppIntents.AppIntent", "AppIntents.AppIntent"], ["AppIntents.AppIntent", "AppIntents.AppEntity"]]:
            decls = copy.deepcopy(self.decls); decls[0]["conformances"] = value
            with self.subTest(value=value), self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", decls)

    def test_missing_mangling_invalid_properties_and_value_kinds_rejected(self):
        for field, value in [("mangledTypeName", ""), ("properties", None), ("properties", [{}]), ("associatedTypeAliases", [{"typeAliasName": "", "substitutedTypeName": ""}])]:
            decls = copy.deepcopy(self.decls); decls[0][field] = value
            with self.subTest(field=field), self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", decls)
        self.changed("StartLockedVoiceIntent", "title")["valueKind"] = []
        with self.assertRaises(p.Unsupported): p.analyze("NanocodexInbox", self.decls)

    def test_sidecar_file_directory_collision_rejected_before_replay_output(self):
        self.make_profile()
        blob = self.profile["sidecars"]["nlu/TEST_ONLY.fixture"]
        self.profile["sidecars"]["nlu/TEST_ONLY.fixture/child"] = copy.deepcopy(blob)
        self.profile["captureBindings"]["metadataSHA256"]["nlu/TEST_ONLY.fixture/child"] = blob["sha256"]
        with self.assertRaisesRegex(p.Unsupported, "path collision"):
            p.replay(self.ir, self.sources, CONTEXT, self.profile)

    def test_saved_profile_invalid_version_and_bindings_cannot_bypass_validation(self):
        self.make_profile()
        for field in ["sourceManifest", "buildContext", "compilerSemanticSHA256", "metadataSHA256"]:
            profile = copy.deepcopy(self.profile); profile["captureBindings"].pop(field)
            with self.subTest(field=field), self.assertRaises(p.Unsupported): p.replay(self.ir, self.sources, CONTEXT, profile)
        version = b'{"version":3}'
        binding = copy.deepcopy(self.binding); binding["metadataSHA256"]["version.json"] = hashlib.sha256(version).hexdigest()
        with self.assertRaisesRegex(p.Unsupported, "version.json invalid"):
            p.make_reference(self.ir, self.sources, CONTEXT, self.actions, version, PROVENANCE, p.unpack_sidecars(self.profile), binding)

    def test_widgets_calibration_cli_and_invalid_paired_input_shape(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base = ["calibrate", "--module", "NanocodexWidgets", "--const-values", str(FIXTURES / "widgets.swiftconstvalues.json"),
                    "--actionsdata", str(FIXTURES / "mac-metadata/widgets/extract.actionsdata"), "--version-json", str(FIXTURES / "mac-metadata/widgets/version.json"),
                    "--provenance", str(FIXTURES / "mac-paired-provenance.json")]
            paired = sum((["--reference-const-values", str(path)] for path in sorted((FIXTURES / "mac-compiler-inputs/widgets").glob("*.swiftconstvalues"))), [])
            output = root / "widgets.json"
            self.assertEqual(p.main(base + paired + ["--output", str(output)]), 0)
            self.assertEqual(len(p.read_json(output)["checks"]), 22)
            before = output.read_bytes()
            self.assertEqual(p.main(base + paired + ["--output", str(output)]), 1)
            self.assertEqual(output.read_bytes(), before)
            malformed = root / "malformed.json"; malformed.write_text("{}")
            failed = root / "failed.json"
            self.assertEqual(p.main(base + ["--reference-const-values", str(malformed), "--output", str(failed)]), 1)
            self.assertFalse(failed.exists())

    def test_cli_mock_source_context_and_complete_sidecar_inventory_guards(self):
        # Apple widget bytes with wholly MOCK source/context. No production profile.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); source = root / "source"; source.mkdir(); (source / "main.swift").write_text("// MOCK ONLY")
            decls = compiler("NanocodexWidgets")
            for declaration in decls: declaration["file"] = str(source / "main.swift")
            constants = root / "constants.json"; constants.write_text(json.dumps(decls))
            context = root / "context.json"; context.write_text(json.dumps(CONTEXT))
            sources = root / "sources.json"; sources.write_text(json.dumps(p.source_manifest(source)))
            provenance = root / "provenance.json"; provenance.write_text(json.dumps(PROVENANCE))
            metadata = root / "metadata"; metadata.mkdir()
            for name in ["extract.actionsdata", "version.json"]:
                (metadata / name).write_bytes((FIXTURES / "mac-metadata/widgets" / name).read_bytes())
            (metadata / "nlu").mkdir(); (metadata / "nlu/mock.fixture").write_bytes(b"MOCK_NOT_APPLE_NLU")
            inventory = root / "inventory.json"
            hashes = {str(x.relative_to(metadata)): hashlib.sha256(x.read_bytes()).hexdigest() for x in metadata.rglob("*") if x.is_file()}
            inventory.write_text(json.dumps(hashes))
            profile = root / "profile.json"
            common = ["--module", "NanocodexWidgets", "--const-values", str(constants), "--source-root", str(source), "--context", str(context)]
            paired = sum((["--reference-const-values", str(path)] for path in sorted((FIXTURES / "mac-compiler-inputs/widgets").glob("*.swiftconstvalues"))), [])
            reference = ["reference"] + common + paired + ["--actionsdata", str(metadata / "extract.actionsdata"), "--version-json", str(metadata / "version.json"), "--provenance", str(provenance),
                         "--reference-source-manifest", str(sources), "--reference-context", str(context), "--metadata-inventory", str(inventory), "--metadata-dir", str(metadata)]
            for label, mutation in [("context", lambda: context.write_text(json.dumps(dict(CONTEXT, sdkBuild="WRONG")))),
                                    ("inventory", lambda: inventory.write_text(json.dumps({k: v for k, v in hashes.items() if not k.startswith("nlu/")}))),
                                    ("pair", lambda: (metadata / "version.json").unlink()),
                                    ("source-location", lambda: constants.write_text(json.dumps([dict(d, file=str(root / "outside.swift")) for d in decls]))),
                                    ("sidecar-symlink", lambda: (metadata / "nlu/link").symlink_to(source / "main.swift"))]:
                context.write_text(json.dumps(CONTEXT)); inventory.write_text(json.dumps(hashes)); constants.write_text(json.dumps(decls))
                (metadata / "version.json").write_bytes((FIXTURES / "mac-metadata/widgets/version.json").read_bytes())
                mutation(); output = root / (label + "-rejected.json")
                # A separately captured context does not change with current context.
                captured_context = root / "captured-context.json"; captured_context.write_text(json.dumps(CONTEXT))
                args = list(reference); args[args.index("--reference-context") + 1] = str(captured_context)
                self.assertEqual(p.main(args + ["--output", str(output)]), 1, label)
                self.assertFalse(output.exists(), label)
                link = metadata / "nlu/link"
                if link.is_symlink(): link.unlink()
            context.write_text(json.dumps(CONTEXT)); inventory.write_text(json.dumps(hashes)); constants.write_text(json.dumps(decls))
            self.assertEqual(p.main(reference + ["--output", str(profile)]), 0)
            emitted = root / "replayed"
            self.assertEqual(p.main(["emit"] + common + ["--profile", str(profile), "--output", str(emitted)]), 0)
            self.assertEqual((emitted / "nlu/mock.fixture").read_bytes(), b"MOCK_NOT_APPLE_NLU")
            for label, mutation in [("context", lambda: context.write_text(json.dumps(dict(CONTEXT, sdkBuild="CHANGED")))),
                                    ("sidecar", lambda: profile.write_text(json.dumps(dict(p.read_json(profile), sidecars={}))))]:
                context.write_text(json.dumps(CONTEXT)); mutation(); output = root / (label + "-emit")
                self.assertEqual(p.main(["emit"] + common + ["--profile", str(profile), "--output", str(output)]), 1)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
