#!/usr/bin/env python3
"""Fail-closed .swiftconstvalues processor (experimental; NOT build-integrated).

`analyze` produces lossless, path-independent semantic IR, not Apple metadata.
`reference` binds an Apple extractor pair to exact compiler facts, complete Swift
source manifest and explicit build context; `emit` can replay only that binding.
Replay is a narrow, offline alternative to inventing Apple's private numeric
schema. It does NOT synthesize metadata for changed inputs or prove OS discovery.
Runtime constants are recorded as unknown, never interpreted as defaults. A
reference attestation is operator-supplied evidence, not Apple authentication.
"""
from __future__ import annotations
import argparse
import base64
from collections import Counter
import hashlib
import json
import re
from pathlib import Path
import sys

FORMAT = "nanocodex-appintents-compiler-ir-v1"
REFERENCE = "nanocodex-appintents-exact-reference-v2"
CATEGORIES = {"AppIntents.AppIntent": "actions", "AppIntents.AppEntity": "entities",
              "AppIntents.EntityQuery": "queries", "AppIntents.AppShortcutsProvider": "providers"}
VALUE_KINDS = {"RawLiteral", "NilLiteral", "Runtime", "InitCall", "Enum", "Array",
               "KeyPath", "InterpolatedStringLiteral", "Builder", "MemberReference", "StaticFunctionCall"}
CONTEXT_KEYS = {"sdkBuild", "swiftCompilerVersion", "targetTriple", "bundleIdentifier", "buildMode"}

class Unsupported(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise Unsupported(message)

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def read_json_bytes(data):
    # Duplicate JSON keys can silently erase actions/arguments in ordinary json.load.
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, f"duplicate JSON key: {key}")
            out[key] = value
        return out
    return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda v: (_ for _ in ()).throw(Unsupported(f"non-finite JSON number: {v}")))

def read_json(path):
    return read_json_bytes(Path(path).read_bytes())

def sanitize(value):
    """Keep every compiler field except source locations; do not flatten ASTs."""
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items() if k not in {"file", "line"}}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value

def validate_ast(node, path, unresolved):
    if isinstance(node, list):
        for index, value in enumerate(node):
            validate_ast(value, f"{path}/{index}", unresolved)
        return
    if not isinstance(node, dict):
        return
    if "valueKind" in node:
        kind = node["valueKind"]
        require(isinstance(kind, str) and kind in VALUE_KINDS, f"{path}: unsupported valueKind {kind!r}")
        value = node.get("value")
        if kind in {"Runtime", "NilLiteral"}:
            require(value is None, f"{path}: {kind} with unexpected value")
            if kind == "Runtime":
                unresolved.append({"path": path, "type": node.get("type"), "reason": "compiler-runtime-value"})
        elif kind == "RawLiteral":
            require(isinstance(value, (str, int, float, bool)), f"{path}: malformed literal")
        elif kind == "Array":
            require(isinstance(value, list) and all(isinstance(e, dict) and "valueKind" in e for e in value), f"{path}: malformed array")
        else:
            require(isinstance(value, dict), f"{path}: malformed {kind}")
            required = {"InitCall": {"type", "arguments"}, "Enum": {"name"},
                        "KeyPath": {"path", "rootType", "components"},
                        "InterpolatedStringLiteral": {"segments"}, "Builder": {"type", "members"},
                        "MemberReference": {"baseType", "memberLabel"},
                        "StaticFunctionCall": {"type", "memberLabel", "arguments"}}[kind]
            require(set(value) == required, f"{path}: unsupported {kind} fields {sorted(set(value))}")
            for key in required & {"arguments", "components", "segments", "members"}:
                require(isinstance(value[key], list), f"{path}: {key} must be array")
            for key in required - {"arguments", "components", "segments", "members"}:
                require(isinstance(value[key], str) and (value[key] or (kind == "Builder" and key == "type")), f"{path}: {key} must be string (only compiler summary Builder type may be empty)")
            if "arguments" in required:
                require(all(isinstance(a, dict) and isinstance(a.get("label"), str) and isinstance(a.get("type"), str) and isinstance(a.get("valueKind"), str) and a["valueKind"] in VALUE_KINDS for a in value["arguments"]), f"{path}: malformed call argument")
            if "segments" in required:
                require(all(isinstance(a, dict) and isinstance(a.get("valueKind"), str) and a["valueKind"] in VALUE_KINDS for a in value["segments"]), f"{path}: malformed interpolation segment")
    for key, value in node.items():
        validate_ast(value, f"{path}/{key}", unresolved)

def args_of(node, constructor=None):
    require(isinstance(node, dict), "expected initializer node")
    require(node.get("valueKind") == "InitCall", "expected known initializer")
    value = node["value"]
    if constructor:
        require(value["type"] == constructor, f"unexpected initializer {value['type']}")
    args = value["arguments"]
    # Some compiler calls legitimately have several unlabelled closure arguments.
    labels = [a.get("label") for a in args if a.get("label")]
    require(len(labels) == len(set(labels)), "duplicate labeled initializer arguments")
    return {a["label"]: a for a in args if a.get("label")}

def parameter_type(type_name, entities):
    prefix = "AppIntents.IntentParameter<"
    require(type_name.startswith(prefix) and type_name.endswith(">"), f"invalid parameter type: {type_name}")
    inner = type_name[len(prefix):-1]
    optional = inner.startswith("Swift.Optional<") and inner.endswith(">")
    bare = inner[len("Swift.Optional<"):-1] if optional else inner
    if bare in entities:
        kind = "entity"
    else:
        require(bare in {"Swift.String", "Foundation.URL", "Foundation.Date", "AppIntents.IntentFile"},
                f"unsupported parameter value type {bare}")
        kind = "primitive"
    return {"swiftType": inner, "unwrappedSwiftType": bare, "isOptional": optional, "kind": kind}

def analyze(module, declarations):
    require(isinstance(module, str) and module and "/" not in module, "invalid module")
    require(isinstance(declarations, list) and declarations, "compiler constants must be nonempty array")
    names = [d.get("typeName") for d in declarations if isinstance(d, dict)]
    require(len(names) == len(declarations) and all(isinstance(n, str) and n.startswith(module + ".") for n in names),
            "invalid declaration or module mismatch")
    require(len(names) == len(set(names)), "duplicate compiler declaration")
    facts = {category: {} for category in CATEGORIES.values()}
    normalized = sorted(sanitize(declarations), key=lambda d: d["typeName"])
    unresolved = []
    # Validate declarations before querying conformances (None/dict must not
    # leak into identity discovery or cause partially interpreted facts).
    for d in normalized:
        require(isinstance(d.get("conformances"), list) and all(isinstance(c, str) and c for c in d["conformances"]), f"{d['typeName']}: invalid conformances")
    entities = {d["typeName"] for d in normalized if "AppIntents.AppEntity" in d["conformances"]}
    for d in normalized:
        name = d["typeName"]
        require(isinstance(d.get("conformances"), list) and all(isinstance(c, str) and c for c in d["conformances"]), f"{name}: invalid conformances")
        require(len(set(d["conformances"])) == len(d["conformances"]), f"{name}: duplicate conformance")
        categories = [cat for proto, cat in CATEGORIES.items() if proto in d["conformances"]]
        require(len(categories) == 1, f"{name}: unsupported/ambiguous declaration conformances")
        category = categories[0]
        require(isinstance(d.get("mangledTypeName"), str) and d["mangledTypeName"], f"{name}: missing compiler mangling")
        validate_ast(d, name, unresolved)
        properties = d.get("properties", [])
        require(isinstance(properties, list), f"{name}: invalid properties")
        require(all(isinstance(p, dict) and isinstance(p.get("label"), str) and p["label"] and isinstance(p.get("type"), str) and p["type"] and isinstance(p.get("valueKind"), str) and p["valueKind"] in VALUE_KINDS for p in properties),
                f"{name}: invalid property")
        props = {p["label"]: p for p in properties}
        require(len(props) == len(properties), f"{name}: duplicate property")
        aliases = d.get("associatedTypeAliases", [])
        require(isinstance(aliases, list) and all(isinstance(a, dict) and isinstance(a.get("typeAliasName"), str) and a["typeAliasName"] and isinstance(a.get("substitutedTypeName"), str) and a["substitutedTypeName"] for a in aliases), f"{name}: invalid associated aliases")
        alias_values = {}
        for alias in aliases:
            label = alias["typeAliasName"]
            require(label not in alias_values or alias_values[label] == alias, f"{name}: conflicting associated alias")
            alias_values[label] = alias
        fact = {"mangledTypeName": d["mangledTypeName"], "conformances": d["conformances"],
                "properties": properties, "associatedTypeAliases": aliases}
        if category == "actions":
            require("title" in props and props["title"].get("valueKind") != "Runtime", f"{name}: unresolved title")
            parameters = []
            for p in properties:
                if not (p.get("type", "").startswith("AppIntents.IntentParameter<") and p["label"].startswith("_")):
                    continue
                label = p["label"][1:]
                require(label and label in props and "$" + label in props, f"{name}: missing parameter wrapper peers {label}")
                typed = parameter_type(p["type"], entities)
                require(props[label]["type"] == typed["swiftType"], f"{name}: parameter peer type mismatch {label}")
                require(props[label].get("value") == p.get("value"), f"{name}: parameter peer initializer mismatch {label}")
                require(props['$' + label]["type"] == p["type"], f"{name}: projected parameter mismatch {label}")
                arguments = args_of(p, p["type"])
                require("title" in arguments, f"{name}: missing parameter title {label}")
                parameters.append({"name": label, "valueType": typed, "initializer": p,
                                   "explicitWrapperArguments": props[label].get("propertyWrappers", [])})
            backing = {"_" + p["name"] for p in parameters}
            for p in properties:
                if p.get("type", "").startswith("AppIntents.IntentParameter<") and not p["label"].startswith("$"):
                    require(p["label"] in backing, f"{name}: unsupported non-backing parameter {p['label']}")
            fact["parameters"] = parameters
            fact["authenticationPolicy"] = props.get("authenticationPolicy", {"status": "not-explicit-in-compiler-input"})
            fact["supportedModes"] = props.get("supportedModes", {"status": "not-explicit-in-compiler-input"})
        elif category == "entities":
            require("defaultQuery" in props, f"{name}: missing defaultQuery")
            args_of(props["defaultQuery"])
            query = props["defaultQuery"]["value"]["type"]
            require(any(q["typeName"] == query and "AppIntents.EntityQuery" in q["conformances"] for q in normalized),
                    f"{name}: defaultQuery target unavailable")
            fact["defaultQueryType"] = query
        elif category == "queries":
            entity_aliases = sorted({a["substitutedTypeName"] for a in aliases if a.get("typeAliasName") == "Entity"})
            require(len(entity_aliases) == 1 and entity_aliases[0] in entities, f"{name}: unresolved query Entity alias")
            fact["entityType"] = entity_aliases[0]
        elif category == "providers":
            require("appShortcuts" in props, f"{name}: missing shortcuts")
            builder = props["appShortcuts"]
            require(builder.get("valueKind") == "Builder" and builder["value"]["type"] == "AppIntents.AppShortcutsBuilder",
                    f"{name}: unsupported shortcuts builder")
            shortcuts = []
            for member in builder["value"]["members"]:
                require(isinstance(member, dict) and set(member) == {"kind", "element"} and member["kind"] == "buildExpression",
                        f"{name}: unsupported conditional/nested builder member")
                call = member["element"]
                arguments = args_of(call, "AppIntents.AppShortcut")
                require({"intent", "phrases", "shortTitle", "systemImageName"} <= set(arguments),
                        f"{name}: incomplete shortcut arguments")
                action = arguments["intent"]["type"]
                args_of(arguments["intent"], action)
                require(any(a["typeName"] == action and "AppIntents.AppIntent" in a["conformances"] for a in normalized),
                        f"{name}: unknown shortcut action {action}")
                phrases = arguments["phrases"]
                require(phrases.get("valueKind") == "Array" and phrases.get("value"), f"{name}: missing phrases")
                for phrase in phrases["value"]:
                    require(phrase.get("valueKind") in {"RawLiteral", "InterpolatedStringLiteral"}, f"{name}: unsupported phrase")
                    for segment in phrase.get("value", {}).get("segments", []) if isinstance(phrase.get("value"), dict) else []:
                        require(segment.get("valueKind") in {"RawLiteral", "Enum", "KeyPath"}, f"{name}: unresolved phrase segment")
                        if segment["valueKind"] == "Enum":
                            require(segment["value"]["name"] == "applicationName", f"{name}: unsupported phrase enum")
                shortcuts.append({"actionType": action, "initializer": call})
            fact["shortcuts"] = shortcuts
        facts[category][name] = fact
    return {"format": FORMAT, "module": module, "compilerDeclarations": normalized,
            "compilerSemanticSHA256": digest(normalized), "requirements": facts,
            "runtimeUnknowns": unresolved, "phoneDiscoveryVerified": False,
            "appleSchemaSynthesized": False}

def literal_localized(node):
    require(node.get('valueKind')=='RawLiteral' and isinstance(node.get('value'),str), 'localized literal not comparable')
    return {'key':node['value'],'alternatives':[]}

def compiler_format(node, owner, parameters, application=False):
    if node.get('valueKind')=='RawLiteral':return node['value'],[]
    require(node.get('valueKind')=='InterpolatedStringLiteral','unresolved interpolation')
    text=[];ids=[]
    for s in node['value']['segments']:
        k,v=s['valueKind'],s.get('value')
        if k=='RawLiteral':text.append(v)
        elif application and k=='Enum' and v['name']=='applicationName':text.append('${applicationName}')
        elif k=='KeyPath':
            require(v['rootType']==owner and v['path'].startswith('$') and v['path'][1:] in parameters,'unknown interpolation keypath')
            name=v['path'][1:];ids.append(name);text.append('${'+name+'}')
        else:raise Unsupported('unsupported interpolation for comparison')
    return ''.join(text),ids

def compare_reference(ir,data,version):
    """Observed schema associations, NOT paired-source proof or numeric meanings."""
    require(isinstance(version, dict) and isinstance(version.get("version"), str) and version["version"], "reference version.json invalid")
    check_coverage(ir,data);checks=[];observations=[]
    def same(path,want,actual):checks.append({'path':path,'matches':want==actual,'compilerExpected':want,'referenceActual':actual})
    for name,f in ir['requirements']['actions'].items():
        bare=name.rsplit('.',1)[-1];e=data['actions'][bare];props={x['label']:x for x in f['properties']};base='actions/'+bare
        same(base+'/title',literal_localized(props['title']),e.get('title'))
        if 'description' in props:same(base+'/description',literal_localized(props['description']),e.get('descriptionMetadata',{}).get('descriptionText'))
        same(base+'/identity',name,e.get('fullyQualifiedTypeName'))
        out={p['name']:p for p in e.get('parameters',[])}
        for param in f['parameters']:
            n=param['name'];args=args_of(param['initializer']);value=out[n];path=base+'/parameters/'+n
            same(path+'/title',literal_localized(args['title']),value.get('title'))
            same(path+'/isOptional',param['valueType']['isOptional'],value.get('isOptional'))
            default=args.get('default',{'valueKind':'NilLiteral'})
            if default['valueKind']=='RawLiteral':
                require(isinstance(default['value'],str),'unsupported nonstring default comparison')
                same(path+'/defaultString',['LNValueTypeSpecificMetadataKeyDefaultValue',{'string':{'wrapper':default['value']}}],value.get('typeSpecificMetadata'))
            elif default['valueKind']=='NilLiteral':same(path+'/defaultAbsent',[],value.get('typeSpecificMetadata'))
            else:raise Unsupported('runtime default not comparable')
            observations.append({'path':path,'kind':'parameterValueType','compilerSwiftType':param['valueType']['swiftType'],'referenceValue':value['valueType'],'numericMeaningVerified':False})
        if 'parameterSummary' in props:
            call=props['parameterSummary'];args_of(call, 'AppIntents.IntentParameterSummary<'+name+'>');args=call['value']['arguments']
            require(args and args[0].get('label')=='','unknown summary argument')
            text,ids=compiler_format(args[0],name,out);others=[]
            for a in args[1:]:
                # The actual paired compiler captures include a nil table
                # argument, not just the optional keypath builder. This exact
                # absent-localization-table form is comparable; nonnil/runtime
                # tables must not be silently dropped or treated as defaults.
                if a.get('label') == 'table':
                    require(a.get('type')=='Swift.Optional<Swift.String>' and a.get('valueKind')=='NilLiteral','unsupported summary localization table')
                    continue
                require(a.get('label')=='' and a.get('valueKind')=='Builder' and a['value']['type']=='','unsupported summary trailing argument')
                if a.get('valueKind')=='Builder':
                    for m in a['value']['members']:
                        require(isinstance(m, dict) and set(m)=={'kind','element'} and m.get('kind')=='buildExpression' and isinstance(m['element'], dict) and m['element'].get('valueKind')=='KeyPath','unsupported summary builder')
                        v=m['element']['value'];require(v['rootType']==name and v['path'].startswith('$') and v['path'][1:] in out,'unknown summary keypath');others.append(v['path'][1:])
            same(base+'/summary',{'summaryString':{'formatString':text,'parameterIdentifiers':ids},'otherParameterIdentifiers':others},e.get('actionConfiguration',{}).get('actionSummary',{}).get('wrapper'))
        for label in ['authenticationPolicy','supportedModes']:
            if label in props:observations.append({'path':base+'/'+label,'kind':label,'compilerAST':props[label],'referenceValue':e.get(label),'numericMeaningVerified':False})
    for name,f in ir['requirements']['entities'].items():
        bare=name.rsplit('.',1)[-1];e=data['entities'][bare];props={x['label']:x for x in f['properties']}
        same('entities/'+bare+'/defaultQuery',f['defaultQueryType'],e.get('defaultQueryIdentifier'))
        same('entities/'+bare+'/displayTypeName',literal_localized(args_of(props['typeDisplayRepresentation'])['name']),e.get('displayTypeName'))
    for name,f in ir['requirements']['queries'].items():
        e=data['queries'][name.rsplit('.',1)[-1]]
        same('queries/'+name+'/entityType',f['entityType'].rsplit('.',1)[-1],e.get('entityType'))
        observations.append({'path':'queries/'+name,'kind':'queryCapabilities','compilerConformances':f['conformances'],'referenceValue':e.get('capabilities'),'numericMeaningVerified':False})
    shortcuts=[]
    for provider in ir['requirements']['providers'].values():
        for s in provider['shortcuts']:
            args=args_of(s['initializer']);action=s['actionType'];params={p['name'] for p in ir['requirements']['actions'][action]['parameters']}
            shortcuts.append({'actionIdentifier':action.rsplit('.',1)[-1],'shortTitle':literal_localized(args['shortTitle']),
                'systemImageName':args['systemImageName']['value'],'phraseTemplates':[{'key':compiler_format(x,action,params,True)[0],'alternatives':[]} for x in args['phrases']['value']]})
    same('autoShortcuts',shortcuts,[{k:s.get(k) for k in ['actionIdentifier','shortTitle','systemImageName','phraseTemplates']} for s in data.get('autoShortcuts',[])])
    return {'kind':'observed-reference-compiler-comparison','module':ir['module'],'checks':checks,'allComparableFactsMatch':all(c['matches'] for c in checks),
            'opaqueNumericAssociations':observations,'referenceGenerator':data.get('generator'),'referenceVersion':version,
            'pairedReferenceCompilerInputVerified':False,'schemaNumericSemanticsVerified':False,'appleSchemaSynthesized':False,'phoneDiscoveryVerified':False,
            'boundaries':['Missing same-build reference compiler constants, source manifest and SDK/compiler context',
                'Numeric associations are artifact observations, not universal mappings',
                'Runtime inputConnectionBehavior/DateKind/file content types unresolved','NLU sidecars opaque; no regeneration supported']}

def calibrate(ir, reference_ir, data, version, provenance):
    """Same-DerivedData association evidence; never an emission profile."""
    require(reference_ir["module"] == ir["module"] and reference_ir["compilerSemanticSHA256"] == ir["compilerSemanticSHA256"],
            "paired reference compiler facts differ from Linux; calibration unsupported")
    require(isinstance(provenance, dict) and isinstance(provenance.get("authority"), str) and provenance["authority"] and
            isinstance(provenance.get("buildReference"), str) and provenance["buildReference"], "capture provenance missing build authority")
    report = compare_reference(ir, data, version)
    require(report["allComparableFactsMatch"], "reference metadata/compiler literal facts disagree")
    report.update(kind="paired-compiler-schema-calibration-evidence", pairedReferenceCompilerInputVerified=True,
                  pairedCaptureAuthority={k: provenance[k] for k in ("authority", "buildReference")},
                  compilerSemanticSHA256=ir["compilerSemanticSHA256"],
                  exactASTEncodingAssociationsObservedInCapture=True, universalNumericMeaningsVerified=False,
                  sameImmutableSourceManifestVerified=False, sameSDKCompilerContextVerified=False,
                  actionsSemanticSHA256=digest(data), versionSemanticSHA256=digest(version))
    report["boundaries"] = ["Immutable full source manifest and SDK/compiler/target/build context not independently bound",
        "Exact AST/code observations apply only to this captured schema/toolchain; no bit decomposition or new enum meanings",
        "Runtime SDK defaults, query methods/capability meanings and NLU generation remain unsupported",
        "Calibration is evidence, not an emission profile or a general metadata synthesizer"]
    return report

def source_manifest(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink(), "source root missing or symlink")
    # Reject directory links too: rglob alone can silently omit linked sources.
    require(all(not p.is_symlink() for p in root.rglob("*")), "symlink source tree unsupported")
    files = sorted(root.rglob("*.swift"))
    require(files, "source manifest empty")
    manifest = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    check_manifest(manifest)
    return manifest

def safe_relative(name, prefix=None):
    require(isinstance(name, str) and name and "\\" not in name and "\x00" not in name and
            not name.startswith("/") and all(p not in {"", ".", ".."} for p in name.split("/")), "unsafe relative path")
    require(prefix is None or name.startswith(prefix + "/"), "unsupported metadata sidecar")
    return name

def check_manifest(manifest):
    require(isinstance(manifest, dict) and manifest, "source manifest empty/invalid")
    for name, sha in manifest.items():
        safe_relative(name)
        require(name.endswith(".swift") and isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha), "invalid Swift source manifest entry")

def check_capture_binding(ir, sources, context, payloads, binding):
    """Operator capture records, not cryptographic Apple attestation."""
    check_manifest(sources)
    require(isinstance(binding, dict), "reference requires separately captured source/context/metadata inventory bindings")
    check_manifest(binding.get("sourceManifest"))
    check_context(binding.get("buildContext"))
    require(binding["sourceManifest"] == sources, "paired reference source manifest differs")
    require(binding["buildContext"] == context, "paired reference SDK/compiler/target/build context differs")
    require(binding.get("compilerSemanticSHA256") == ir["compilerSemanticSHA256"], "paired reference compiler binding differs")
    inventory = binding.get("metadataSHA256")
    expected = {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
    require(isinstance(inventory, dict) and inventory == expected, "complete captured metadata inventory differs; sidecar loss/tampering unsupported")

def check_context(context):
    require(isinstance(context, dict) and CONTEXT_KEYS <= set(context), "build context lacks SDK/compiler/target/bundle/mode")
    require(all(isinstance(context[k], str) and context[k] for k in CONTEXT_KEYS), "empty/invalid build context")

def check_coverage(ir, data):
    """Known container checks only; no assertion about numeric schema meaning."""
    facts = ir["requirements"]
    require(isinstance(data, dict), "reference metadata root must be object")
    for category in ("actions", "entities", "queries"):
        entries = data.get(category)
        require(isinstance(entries, dict), f"reference missing {category} map")
        expected = {n.rsplit('.', 1)[-1] for n in facts[category]}
        require(set(entries) == expected, f"reference {category} coverage differs: expected {sorted(expected)}, got {sorted(entries)}")
        for name, fact in facts[category].items():
            entry = entries[name.rsplit('.', 1)[-1]]
            require(isinstance(entry, dict), "reference declaration must be object")
            require(entry.get("mangledTypeName") == fact["mangledTypeName"], f"reference compiler mangling mismatch {name}")
            if category == "actions":
                parameters = entry.get("parameters", [])
                require(isinstance(parameters, list) and all(isinstance(p, dict) for p in parameters), f"reference parameter list malformed {name}")
                require(Counter(p.get("name") for p in parameters) == Counter(p["name"] for p in fact["parameters"]),
                        f"reference parameter coverage differs {name}")
                require(all(isinstance(p.get("valueType"), dict) and p["valueType"] for p in parameters),
                        f"reference parameter type missing {name}")
                if "status" not in fact["authenticationPolicy"]:
                    require(entry.get("isAuthPolExplicit") is True and "authenticationPolicy" in entry,
                            f"reference explicit authentication missing {name}")
                if "status" not in fact["supportedModes"]:
                    require("supportedModes" in entry, f"reference supportedModes missing {name}")
    shortcuts = data.get("autoShortcuts", [])
    require(isinstance(shortcuts, list) and all(isinstance(s, dict) for s in shortcuts), "reference shortcuts malformed")
    expected = Counter(s["actionType"].rsplit('.', 1)[-1] for p in facts["providers"].values() for s in p["shortcuts"])
    require(Counter(s.get("actionIdentifier") for s in shortcuts) == expected, "reference shortcut coverage differs")
    # Multiple providers have framework-specific merge rules; do not assume first.
    require(len(facts["providers"]) <= 1, "multiple providers not yet supported for replay")
    if facts["providers"]:
        provider = next(iter(facts["providers"].values()))
        require(data.get("autoShortcutProviderMangledName") == provider["mangledTypeName"], "reference provider mangling mismatch")

def make_reference(ir, sources, context, actions_bytes, version_bytes, provenance, sidecars=None, capture_binding=None):
    sidecars = {} if sidecars is None else sidecars
    require(not ir["requirements"]["providers"] or sidecars, "shortcut reference requires captured NLU sidecars; pair-only replay unsupported")
    require(isinstance(sidecars, dict), "invalid sidecar map")
    for name, data in sidecars.items():
        safe_relative(name, "nlu")
        require(isinstance(data, bytes), "unsupported metadata sidecar bytes")
        require(not any(parent in sidecars for parent in ("/".join(name.split("/")[:i]) for i in range(1, len(name.split("/"))))),
                "sidecar file/directory path collision")
    check_context(context)
    require(isinstance(provenance, dict), "reference provenance must be object")
    check_capture_binding(ir, sources, context, {"extract.actionsdata": actions_bytes, "version.json": version_bytes, **sidecars}, capture_binding)
    require(provenance.get("primaryTool") == "appintentsmetadataprocessor", "reference requires Apple extractor provenance")
    require(all(isinstance(provenance.get(k), str) and provenance[k] for k in ("captureDescription", "captureEvidence")),
            "reference missing capture evidence")
    actions = read_json_bytes(actions_bytes)
    version = read_json_bytes(version_bytes)
    require(isinstance(version, dict) and isinstance(version.get("version"), str) and version["version"], "reference version.json invalid")
    check_coverage(ir, actions)
    return {"format": REFERENCE, "module": ir["module"], "compilerSemanticSHA256": ir["compilerSemanticSHA256"],
            "sourceManifest": sources, "buildContext": context, "provenance": provenance, "captureBindings": capture_binding,
            "actionsBase64": base64.b64encode(actions_bytes).decode(), "versionBase64": base64.b64encode(version_bytes).decode(),
            "actionsSHA256": hashlib.sha256(actions_bytes).hexdigest(), "versionSHA256": hashlib.sha256(version_bytes).hexdigest(),
            "sidecars": {name: {"base64": base64.b64encode(data).decode(), "sha256": hashlib.sha256(data).hexdigest()} for name, data in sidecars.items()},
            "phoneDiscoveryVerified": False}

def unpack_sidecars(profile):
    sidecars = {}
    require(isinstance(profile.get("sidecars", {}), dict), "invalid sidecar map")
    for name, item in profile.get("sidecars", {}).items():
        require(isinstance(item, dict), "invalid sidecar record")
        safe_relative(name, "nlu")
        data = base64.b64decode(item["base64"], validate=True)
        require(hashlib.sha256(data).hexdigest() == item.get("sha256"), "sidecar checksum mismatch")
        sidecars[name] = data
    return sidecars

def replay(ir, sources, context, profile):
    check_context(context)
    require(isinstance(profile, dict), "reference profile must be object")
    require(profile.get("format") == REFERENCE, "unsupported reference format")
    require(profile.get("module") == ir["module"], "reference module mismatch")
    require(profile.get("compilerSemanticSHA256") == ir["compilerSemanticSHA256"], "compiler semantics differ from reference; synthesis unsupported")
    require(profile.get("sourceManifest") == sources, "source manifest differs; Runtime nodes cannot prove equivalence")
    require(profile.get("buildContext") == context, "SDK/compiler/target/bundle/build context differs; synthesis unsupported")
    a = base64.b64decode(profile["actionsBase64"], validate=True)
    v = base64.b64decode(profile["versionBase64"], validate=True)
    # Revalidate saved profiles as strictly as new profiles; no implicit trust.
    verified = make_reference(ir, sources, context, a, v, profile.get("provenance", {}), unpack_sidecars(profile), profile.get("captureBindings"))
    require(verified["actionsSHA256"] == profile.get("actionsSHA256") and verified["versionSHA256"] == profile.get("versionSHA256"),
            "reference payload checksum mismatch")
    return a, v

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("analyze", "compare-reference", "calibrate", "reference", "emit"))
    parser.add_argument("--module", required=True)
    parser.add_argument("--const-values", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--context", type=Path)
    parser.add_argument("--actionsdata", type=Path)
    parser.add_argument("--version-json", type=Path)
    parser.add_argument("--provenance", type=Path)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--reference-const-values", type=Path, action="append", help="same-build Apple reference compiler input (required to bind a reference)")
    parser.add_argument("--reference-source-manifest", type=Path, help="complete Swift manifest recorded at Apple reference capture")
    parser.add_argument("--reference-context", type=Path, help="SDK/compiler/target/bundle/build context recorded at reference capture")
    parser.add_argument("--metadata-inventory", type=Path, help="capture-relative filename to SHA256 mapping for ALL metadata files")
    parser.add_argument("--metadata-dir", type=Path, help="complete Apple Metadata.appintents reference including opaque NLU sidecars")
    args = parser.parse_args(argv)
    try:
        declarations = []
        for path in args.const_values:
            part = read_json(path)
            require(isinstance(part, list), "compiler constants must be array")
            declarations.extend(part)
        ir = analyze(args.module, declarations)
        if args.operation in {"analyze", "compare-reference", "calibrate"}:
            report = ir
            if args.operation in {"compare-reference", "calibrate"}:
                require(args.actionsdata and args.version_json, "comparison requires reference actionsdata/version")
                report = compare_reference(ir, read_json(args.actionsdata), read_json(args.version_json))
                if args.operation == "calibrate":
                    require(args.reference_const_values and args.provenance, "calibration requires same-build reference compiler inputs and capture provenance")
                    reference_declarations = []
                    for path in args.reference_const_values:
                        part = read_json(path)
                        require(isinstance(part, list), "reference compiler constants must be array")
                        reference_declarations.extend(part)
                    reference_ir = analyze(args.module, reference_declarations)
                    report = calibrate(ir, reference_ir, read_json(args.actionsdata), read_json(args.version_json), read_json(args.provenance))
            require(not args.output.exists(), "output already exists")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("xb") as output:
                output.write(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True).encode() + b"\n")
        else:
            require(args.source_root and args.context, "reference/replay requires complete source root and explicit build context")
            sources, context = source_manifest(args.source_root), read_json(args.context)
            root = args.source_root.resolve()
            for declaration in declarations:
                file_path = Path(declaration.get("file", ""))
                require(file_path.is_absolute() and file_path.resolve().is_relative_to(root),
                        "compiler declaration source is outside supplied source root")
                require(str(file_path.resolve().relative_to(root)) in sources, "compiler declaration source missing from manifest")
            if args.operation == "reference":
                require(args.actionsdata and args.version_json and args.provenance and args.reference_const_values and args.reference_source_manifest and args.reference_context and args.metadata_inventory, "reference requires paired Apple actionsdata/version/provenance, same-build compiler constants, separately captured source manifest/context and complete metadata inventory")
                reference_declarations = []
                for path in args.reference_const_values:
                    part = read_json(path)
                    require(isinstance(part, list), "reference compiler constants must be array")
                    reference_declarations.extend(part)
                reference_ir = analyze(args.module, reference_declarations)
                require(reference_ir["compilerSemanticSHA256"] == ir["compilerSemanticSHA256"], "reference compiler facts differ; synthesis unsupported")
                comparison = compare_reference(reference_ir, read_json(args.actionsdata), read_json(args.version_json))
                require(comparison["allComparableFactsMatch"], "reference compiler/metadata facts disagree")
                sidecars = {}
                if args.metadata_dir:
                    require(args.metadata_dir.is_dir() and not args.metadata_dir.is_symlink(), "metadata directory missing or symlink")
                    require((args.metadata_dir / "extract.actionsdata").is_file() and (args.metadata_dir / "version.json").is_file(), "metadata directory missing captured pair")
                    for path in args.metadata_dir.rglob("*"):
                        require(not path.is_symlink(), "symlink metadata sidecar unsupported")
                        require(path.is_dir() or path.is_file(), "unsupported special metadata file")
                        if path.is_file():
                            name = str(path.relative_to(args.metadata_dir))
                            if name in {"extract.actionsdata", "version.json"}:
                                expected = args.actionsdata if name == "extract.actionsdata" else args.version_json
                                require(path.read_bytes() == expected.read_bytes(), "metadata pair differs from directory capture")
                            else:
                                sidecars[name] = path.read_bytes()
                binding = {"sourceManifest": read_json(args.reference_source_manifest), "buildContext": read_json(args.reference_context),
                           "compilerSemanticSHA256": reference_ir["compilerSemanticSHA256"], "metadataSHA256": read_json(args.metadata_inventory)}
                profile = make_reference(ir, sources, context, args.actionsdata.read_bytes(), args.version_json.read_bytes(), read_json(args.provenance), sidecars, binding)
                require(not args.output.exists(), "output already exists")
                args.output.parent.mkdir(parents=True, exist_ok=True)
                with args.output.open("xb") as output:
                    output.write(json.dumps(profile, indent=2, sort_keys=True).encode() + b"\n")
            else:
                require(args.profile, "emission requires a paired reference; private schema synthesis unsupported")
                profile = read_json(args.profile)
                a, v = replay(ir, sources, context, profile)
                sidecars = unpack_sidecars(profile)
                # All validation is complete before any output mutation; refuse any existing directory.
                require(not args.output.exists(), "output already exists")
                args.output.mkdir(parents=True)
                (args.output / "extract.actionsdata").write_bytes(a)
                (args.output / "version.json").write_bytes(v)
                for name, data in sidecars.items():
                    path = args.output / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"appintents-linux: {error}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
