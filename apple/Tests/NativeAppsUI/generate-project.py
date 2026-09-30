#!/usr/bin/env python3
import json, pathlib
root=pathlib.Path(__file__).resolve().parent
objects={}
def add(key, **props):
    ident=f'{len(objects)+1:024X}'; objects[ident]={'isa':key,**props}; return ident
appfile=add('PBXFileReference', lastKnownFileType='sourcecode.swift', path='Demo/NativeAppsDemo.swift', sourceTree='<group>')
testfile=add('PBXFileReference', lastKnownFileType='sourcecode.swift', path='UITests/NativeAppsUITests.swift', sourceTree='<group>')
fixtures=add('PBXFileReference',lastKnownFileType='folder',path='Fixtures',sourceTree='<group>')
app=add('PBXFileReference',explicitFileType='wrapper.application',path='NativeAppsDemo.app',sourceTree='BUILT_PRODUCTS_DIR')
test=add('PBXFileReference',explicitFileType='wrapper.cfbundle',path='NativeAppsUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR')
products=add('PBXGroup',children=[app,test],name='Products',sourceTree='<group>')
main=add('PBXGroup',children=[appfile,testfile,fixtures,products],sourceTree='<group>')
pkg=add('XCLocalSwiftPackageReference',relativePath='../../apple/NanocodexApps')
product=add('XCSwiftPackageProductDependency',package=pkg,productName='NanocodexApps')
def phase(kind, refs, package=False):
    files=[add('PBXBuildFile', **({'productRef':r} if package else {'fileRef':r})) for r in refs]
    return add(kind,buildActionMask='2147483647',files=files,runOnlyForDeploymentPostprocessing='0')
def configs(settings):
    ids=[add('XCBuildConfiguration',buildSettings={**settings, 'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if name=='Debug' else '-O'},name=name) for name in ['Debug','Release']]
    return add('XCConfigurationList',buildConfigurations=ids,defaultConfigurationIsVisible='0',defaultConfigurationName='Debug')
base={'ONLY_ACTIVE_ARCH':'YES','ALWAYS_SEARCH_USER_PATHS':'NO','SDKROOT':'iphoneos','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SWIFT_VERSION':'5.0','CODE_SIGNING_ALLOWED':'NO','TARGETED_DEVICE_FAMILY':'1,2','GENERATE_INFOPLIST_FILE':'YES'}
appconfig=configs({**base,'PRODUCT_BUNDLE_IDENTIFIER':'dev.nanocodex.nativeapps-ui-demo','PRODUCT_NAME':'$(TARGET_NAME)','INFOPLIST_KEY_UILaunchScreen_Generation':'YES','INFOPLIST_KEY_UIApplicationSceneManifest_Generation':'YES','INFOPLIST_KEY_UISupportedInterfaceOrientations':'UIInterfaceOrientationPortrait'})
apptarget=add('PBXNativeTarget',buildConfigurationList=appconfig,buildPhases=[phase('PBXSourcesBuildPhase',[appfile]),phase('PBXFrameworksBuildPhase',[product],True),phase('PBXResourcesBuildPhase',[fixtures])],buildRules=[],dependencies=[],name='NativeAppsDemo',packageProductDependencies=[product],productName='NativeAppsDemo',productReference=app,productType='com.apple.product-type.application')
dep=add('PBXTargetDependency',target=apptarget)
testconfig=configs({**base,'PRODUCT_BUNDLE_IDENTIFIER':'dev.nanocodex.nativeapps-ui-tests','PRODUCT_NAME':'$(TARGET_NAME)','TEST_TARGET_NAME':'NativeAppsDemo'})
testtarget=add('PBXNativeTarget',buildConfigurationList=testconfig,buildPhases=[phase('PBXSourcesBuildPhase',[testfile]),phase('PBXFrameworksBuildPhase',[])],buildRules=[],dependencies=[dep],name='NativeAppsUITests',productName='NativeAppsUITests',productReference=test,productType='com.apple.product-type.bundle.ui-testing')
project=add('PBXProject',attributes={'LastUpgradeCheck':'2600','TargetAttributes':{testtarget:{'TestTargetID':apptarget}}},buildConfigurationList=configs(base),compatibilityVersion='Xcode 14.0',developmentRegion='en',hasScannedForEncodings='0',knownRegions=['en','Base'],mainGroup=main,productRefGroup=products,projectDirPath='',projectRoot='',packageReferences=[pkg],targets=[apptarget,testtarget])
def render(x):
    if isinstance(x,dict): return '{\n'+''.join(f'{json.dumps(k)} = {render(v)};\n' for k,v in x.items())+'}'
    if isinstance(x,list): return '('+','.join(render(v) for v in x)+')'
    return json.dumps(str(x))
proj=root/'NativeAppsDemo.xcodeproj'; proj.mkdir(exist_ok=True)
(proj/'project.pbxproj').write_text('// !$*UTF8*$!\n'+render({'archiveVersion':'1','classes':{},'objectVersion':'56','objects':objects,'rootObject':project}))
schemes=proj/'xcshareddata/xcschemes'; schemes.mkdir(parents=True,exist_ok=True)
ref=lambda ident,name: f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident}" BuildableName="{name}" BlueprintName="{name.split(".")[0]}" ReferencedContainer="container:NativeAppsDemo.xcodeproj"/>'
(schemes/'NativeAppsDemo.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?><Scheme LastUpgradeVersion="2600" version="1.3"><BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref(apptarget,'NativeAppsDemo.app')}</BuildActionEntry></BuildActionEntries></BuildAction><TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ref(testtarget,'NativeAppsUITests.xctest')}</TestableReference></Testables></TestAction><LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref(apptarget,'NativeAppsDemo.app')}</BuildableProductRunnable></LaunchAction></Scheme>''')
print(proj)
