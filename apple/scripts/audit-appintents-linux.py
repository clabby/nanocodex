#!/usr/bin/env python3
"""Read-only AppIntents gap audit, not a metadata generator or Siri test.

Use --const-values MODULE=PATH for each compiler-emitted .swiftconstvalues file
and --ipa for the unsigned package. Optional --candidate-metadata MODULE=PATH
compares experimental extract.actionsdata with compiler facts outside the IPA.
No candidate is installed, no source is executed, and no private schema numeric
codes are guessed. Even an audit without findings cannot prove OS discovery.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import sys
import zipfile


def load_constants(path):
    declarations = json.loads(Path(path).read_bytes())
    if not isinstance(declarations, list):
        raise ValueError("Compiler constants must be a JSON array")
    for declaration in declarations:
        if not isinstance(declaration, dict) or not isinstance(declaration.get("typeName"), str):
            raise ValueError("Invalid compiler declaration")
        if not isinstance(declaration.get("conformances", []), list):
            raise ValueError("Invalid compiler conformances")
    return declarations


def property_fact(prop):
    # Do not preserve workstation source paths or unrelated compiler properties.
    return {key: prop[key] for key in ("label", "type", "valueKind", "value", "availabilityAttributes") if key in prop}


def requirements(declarations):
    result = {"actions": {}, "entities": {}, "queries": {}, "providers": {}}
    selected = {"title", "authenticationPolicy", "supportedModes", "parameterSummary", "defaultQuery", "typeDisplayRepresentation"}
    for declaration in declarations:
        conformances = set(declaration.get("conformances", []))
        name = declaration["typeName"]
        category = next((category for marker, category in (
            ("AppIntents.AppIntent", "actions"),
            ("AppIntents.AppEntity", "entities"),
            ("AppIntents.EntityQuery", "queries"),
            ("AppIntents.AppShortcutsProvider", "providers"),
        ) if marker in conformances), None)
        if category is None:
            continue
        props = declaration.get("properties", [])
        fact = {"mangledTypeName": declaration.get("mangledTypeName"),
                "conformances": sorted(conformances),
                "properties": [property_fact(p) for p in props if p.get("label") in selected]}
        if category == "actions":
            fact["parameters"] = [property_fact(p) for p in props
                                  if p.get("type", "").startswith("AppIntents.IntentParameter<")
                                  and not p.get("label", "").startswith("$")]
            fact["performResult"] = [p for p in declaration.get("associatedTypeAliases", [])
                                      if p.get("typeAliasName") == "PerformResult"]
        if category == "providers":
            shortcuts = []
            for prop in props:
                if prop.get("label") != "appShortcuts":
                    continue
                for member in prop.get("value", {}).get("members", []):
                    value = member.get("element", {}).get("value", {})
                    if value.get("type") != "AppIntents.AppShortcut":
                        continue
                    arguments = value.get("arguments", [])
                    intent = next((a.get("type") for a in arguments if a.get("label") == "intent"), None)
                    if intent:
                        shortcuts.append({"actionType": intent, "arguments": arguments})
            fact["shortcuts"] = shortcuts
        result[category][name] = fact
    return result


def audit_candidate(expected, data):
    """Conservative structural checks; Apple's undocumented schema stays unverified."""
    findings = []
    actions = data.get("actions", {})
    for name, fact in expected["actions"].items():
        bare = name.rsplit(".", 1)[-1]
        action = actions.get(bare)
        if not isinstance(action, dict):
            findings.append({"code": "missing_action", "type": name})
            continue
        if action.get("mangledTypeName") != fact["mangledTypeName"]:
            findings.append({"code": "mangled_type_mismatch", "type": name})
        authentication = next((p for p in fact["properties"] if p["label"] == "authenticationPolicy"), None)
        if authentication and action.get("isAuthPolExplicit") is not True:
            findings.append({"code": "explicit_authentication_policy_not_preserved", "type": name,
                             "compilerValue": authentication.get("value"),
                             "candidateValue": action.get("authenticationPolicy")})
        parameters = {p.get("name"): p for p in action.get("parameters", [])}
        for parameter in fact["parameters"]:
            label = parameter["label"].removeprefix("_")
            candidate = parameters.get(label)
            if candidate is None:
                findings.append({"code": "missing_parameter", "type": name, "parameter": label})
            # Captured authentic Apple metadata (schema 3.0) uses code 0 for
            # Swift.String. Only flag the universal placeholder for NON-String
            # compiler facts; zero alone is not evidence of a broken String.
            elif (candidate.get("valueType") == {"primitive": {"wrapper": {"typeIdentifier": 0}}}
                  and parameter["type"] != "AppIntents.IntentParameter<Swift.String>"):
                findings.append({"code": "unverified_generic_parameter_type", "type": name,
                                 "parameter": label, "compilerType": parameter["type"]})
    shortcuts = {s.get("actionIdentifier") for s in data.get("autoShortcuts", [])}
    for provider in expected["providers"].values():
        for shortcut in provider["shortcuts"]:
            name = shortcut["actionType"]
            if name.rsplit(".", 1)[-1] not in shortcuts:
                findings.append({"code": "missing_auto_shortcut", "type": name})
    for category in ("entities", "queries"):
        for name in expected[category]:
            if name.rsplit(".", 1)[-1] not in data.get(category, {}):
                findings.append({"code": {"entities": "missing_entity", "queries": "missing_query"}[category], "type": name})
    return {"findings": findings, "schemaCompatibilityVerified": False, "phoneDiscoveryVerified": False}


def inspect_ipa(path):
    bundles = []
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        for name in sorted(names):
            if not (name.endswith(".app/Info.plist") or name.endswith(".appex/Info.plist")):
                continue
            info = plistlib.loads(archive.read(name))
            prefix = name.removesuffix("Info.plist") + "Metadata.appintents/"
            files = sorted(n for n in names if n.startswith(prefix) and not n.endswith("/"))
            bundles.append({"bundle": name.removesuffix("/Info.plist"),
                            "bundleIdentifier": info.get("CFBundleIdentifier"),
                            "metadataFiles": files,
                            "hasMetadataPair": all(prefix + n in names for n in ("extract.actionsdata", "version.json"))})
    return {"sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(), "bundles": bundles,
            "phoneDiscoveryVerified": False}


def module_path(value):
    module, separator, path = value.partition("=")
    if not separator or not module or not path:
        raise argparse.ArgumentTypeError("Expected MODULE=PATH")
    return module, Path(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--const-values", type=module_path, action="append", required=True)
    parser.add_argument("--ipa", type=Path)
    parser.add_argument("--candidate-metadata", type=module_path, action="append", default=[])
    args = parser.parse_args(argv)
    try:
        modules = {}
        for module, path in args.const_values:
            if module in modules:
                raise ValueError(f"Duplicate constants module: {module}")
            declarations = load_constants(path)
            if any(not d["typeName"].startswith(module + ".") for d in declarations):
                raise ValueError(f"Constants module mismatch: {module}")
            modules[module] = requirements(declarations)
        report = {"kind": "read-only-appintents-gap-audit", "phoneDiscoveryVerified": False, "requirements": modules}
        if args.ipa:
            report["ipa"] = inspect_ipa(args.ipa)
        candidates = {}
        for module, path in args.candidate_metadata:
            if module not in modules or module in candidates:
                raise ValueError(f"Unknown or duplicate candidate module: {module}")
            candidates[module] = audit_candidate(modules[module], json.loads(path.read_bytes()))
        if candidates:
            report["candidateAudits"] = candidates
        print(json.dumps(report, indent=2, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        print(f"audit-appintents-linux: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
