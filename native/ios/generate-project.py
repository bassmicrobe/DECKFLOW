#!/usr/bin/env python3
"""Regenerate the dependency-free iPad Xcode project. No XcodeGen is needed."""
from pathlib import Path
import hashlib
import plistlib

ROOT = Path(__file__).resolve().parent
objects = {}


def ident(name):
    return hashlib.sha1(name.encode()).hexdigest()[:24].upper()


def obj(key_name, kind, **values):
    key = ident(key_name)
    objects[key] = dict(isa=kind, **values)
    return key


def ref(name, path, file_type, tree='<group>'):
    return obj(name, 'PBXFileReference', lastKnownFileType=file_type, path=path, sourceTree=tree)


source_names = ['DECKFLOWApp.swift', 'LocalAssetServer.swift', 'NativeMIDI.swift', 'NativeUSB.swift', 'NativeUSBStore.swift']
source_refs = [ref('source.' + name, name, 'sourcecode.swift') for name in source_names]
source_builds = [obj('build.' + name, 'PBXBuildFile', fileRef=reference) for name, reference in zip(source_names, source_refs)]
script_ref = ref('script', 'NativeMIDIBridge.js', 'sourcecode.javascript')
usb_script_ref = ref('usb.script', 'NativeUSBBridge.js', 'sourcecode.javascript')
assets_ref = ref('assets', 'Resources/Web', 'folder')
info_ref = ref('info', 'Info.plist', 'text.plist.xml')
resources = [obj('build.usb.script', 'PBXBuildFile', fileRef=usb_script_ref), obj('build.script', 'PBXBuildFile', fileRef=script_ref), obj('build.assets', 'PBXBuildFile', fileRef=assets_ref)]
app_product = obj('app.product', 'PBXFileReference', explicitFileType='wrapper.application', includeInIndex=0, path='DECKFLOW.app', sourceTree='BUILT_PRODUCTS_DIR')
test_product = obj('test.product', 'PBXFileReference', explicitFileType='wrapper.cfbundle', includeInIndex=0, path='DECKFLOWTests.xctest', sourceTree='BUILT_PRODUCTS_DIR')
test_ref = ref('test.source', 'NativeRuntimeTests.swift', 'sourcecode.swift')
test_build = obj('test.build', 'PBXBuildFile', fileRef=test_ref)
usb_test_ref = ref('usb.test.source', 'NativeUSBTests.swift', 'sourcecode.swift')
usb_test_build = obj('usb.test.build', 'PBXBuildFile', fileRef=usb_test_ref)
app_group = obj('app.group', 'PBXGroup', children=source_refs + [script_ref, usb_script_ref, assets_ref, info_ref], path='DECKFLOW', sourceTree='<group>')
test_group = obj('test.group', 'PBXGroup', children=[test_ref, usb_test_ref], path='DECKFLOWTests', sourceTree='<group>')
products = obj('products', 'PBXGroup', children=[app_product, test_product], name='Products', sourceTree='<group>')
main = obj('main', 'PBXGroup', children=[app_group, test_group, products], sourceTree='<group>')
app_sources = obj('app.sources', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=source_builds, runOnlyForDeploymentPostprocessing=0)
app_resources = obj('app.resources', 'PBXResourcesBuildPhase', buildActionMask=2147483647, files=resources, runOnlyForDeploymentPostprocessing=0)
app_frameworks = obj('app.frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)
test_sources = obj('test.sources', 'PBXSourcesBuildPhase', buildActionMask=2147483647, files=[test_build, usb_test_build], runOnlyForDeploymentPostprocessing=0)
test_frameworks = obj('test.frameworks', 'PBXFrameworksBuildPhase', buildActionMask=2147483647, files=[], runOnlyForDeploymentPostprocessing=0)


def configurations(prefix, settings):
    configs = []
    for name in ['Debug', 'Release']:
        values = dict(settings)
        if name == 'Debug':
            values.update(SWIFT_OPTIMIZATION_LEVEL='-Onone', SWIFT_ACTIVE_COMPILATION_CONDITIONS='DEBUG', ENABLE_TESTABILITY='YES', DEBUG_INFORMATION_FORMAT='dwarf')
        else:
            values.update(SWIFT_OPTIMIZATION_LEVEL='-O', DEBUG_INFORMATION_FORMAT='dwarf-with-dsym')
        configs.append(obj(prefix + '.' + name, 'XCBuildConfiguration', name=name, buildSettings=values))
    return obj(prefix + '.list', 'XCConfigurationList', buildConfigurations=configs, defaultConfigurationIsVisible=0, defaultConfigurationName='Release')


base = dict(SDKROOT='iphoneos', IPHONEOS_DEPLOYMENT_TARGET='17.0', SWIFT_VERSION='5.0', CLANG_ENABLE_MODULES='YES', CLANG_ENABLE_OBJC_ARC='YES', ENABLE_USER_SCRIPT_SANDBOXING='YES', GCC_C_LANGUAGE_STANDARD='gnu17')
project_configs = configurations('project.config', base)
app_settings = dict(PRODUCT_NAME='$(TARGET_NAME)', PRODUCT_BUNDLE_IDENTIFIER='com.bassmicrobe.deckflow', INFOPLIST_FILE='DECKFLOW/Info.plist', GENERATE_INFOPLIST_FILE='NO', CURRENT_PROJECT_VERSION='1', MARKETING_VERSION='0.1.0', TARGETED_DEVICE_FAMILY='2', CODE_SIGN_STYLE='Automatic', SUPPORTS_MACCATALYST='NO', SUPPORTED_PLATFORMS='iphoneos iphonesimulator', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks'])
app_configs = configurations('app.config', app_settings)
app_target = obj('app.target', 'PBXNativeTarget', buildConfigurationList=app_configs, buildPhases=[app_sources, app_frameworks, app_resources], buildRules=[], dependencies=[], name='DECKFLOW', productName='DECKFLOW', productReference=app_product, productType='com.apple.product-type.application')
proxy = obj('test.proxy', 'PBXContainerItemProxy', containerPortal=ident('project'), proxyType=1, remoteGlobalIDString=app_target, remoteInfo='DECKFLOW')
dependency = obj('test.dependency', 'PBXTargetDependency', target=app_target, targetProxy=proxy)
test_settings = dict(PRODUCT_NAME='$(TARGET_NAME)', PRODUCT_BUNDLE_IDENTIFIER='com.bassmicrobe.deckflow.tests', GENERATE_INFOPLIST_FILE='YES', TARGETED_DEVICE_FAMILY='2', TEST_HOST='$(BUILT_PRODUCTS_DIR)/DECKFLOW.app/DECKFLOW', BUNDLE_LOADER='$(TEST_HOST)', CODE_SIGN_STYLE='Automatic', SUPPORTED_PLATFORMS='iphoneos iphonesimulator', LD_RUNPATH_SEARCH_PATHS=['$(inherited)', '@executable_path/Frameworks', '@loader_path/Frameworks'])
test_configs = configurations('test.config', test_settings)
test_target = obj('test.target', 'PBXNativeTarget', buildConfigurationList=test_configs, buildPhases=[test_sources, test_frameworks], buildRules=[], dependencies=[dependency], name='DECKFLOWTests', productName='DECKFLOWTests', productReference=test_product, productType='com.apple.product-type.bundle.unit-test')
project = obj('project', 'PBXProject', attributes={'LastUpgradeCheck': '2700', 'BuildIndependentTargetsInParallel': 'YES', 'TargetAttributes': {app_target: {'CreatedOnToolsVersion': '27.2'}, test_target: {'CreatedOnToolsVersion': '27.2', 'TestTargetID': app_target}}}, buildConfigurationList=project_configs, compatibilityVersion='Xcode 14.0', developmentRegion='ja', hasScannedForEncodings=0, knownRegions=['ja', 'en', 'Base'], mainGroup=main, productRefGroup=products, projectDirPath='', projectRoot='', targets=[app_target, test_target])
project_dir = ROOT / 'DECKFLOW.xcodeproj'
project_dir.mkdir(exist_ok=True)
with (project_dir / 'project.pbxproj').open('wb') as file:
    plistlib.dump(dict(archiveVersion='1', classes={}, objectVersion='56', objects=objects, rootObject=project), file, sort_keys=False)
scheme_dir = project_dir / 'xcshareddata' / 'xcschemes'
scheme_dir.mkdir(parents=True, exist_ok=True)
(scheme_dir / 'DECKFLOW.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
 <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="DECKFLOW.app" BlueprintName="DECKFLOW" ReferencedContainer="container:DECKFLOW.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
 <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{test_target}" BuildableName="DECKFLOWTests.xctest" BlueprintName="DECKFLOWTests" ReferencedContainer="container:DECKFLOW.xcodeproj"/></TestableReference></Testables></TestAction>
 <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="DECKFLOW.app" BlueprintName="DECKFLOW" ReferencedContainer="container:DECKFLOW.xcodeproj"/></BuildableProductRunnable></LaunchAction>
 <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="DECKFLOW.app" BlueprintName="DECKFLOW" ReferencedContainer="container:DECKFLOW.xcodeproj"/></BuildableProductRunnable></ProfileAction>
 <AnalyzeAction buildConfiguration="Debug"/>
 <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''', encoding='utf-8')
print('Generated native/ios/DECKFLOW.xcodeproj')
