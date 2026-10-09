// Real isolated evaluator for public Web API journeys running without Worker.
import { createQuickJsEvaluator } from '../host/index.mjs';
import asyncVariant from '@jitl/quickjs-wasmfile-release-asyncify';
import { newQuickJSAsyncWASMModuleFromVariant } from 'quickjs-emscripten-core';
export const codeEvaluator = createQuickJsEvaluator(await newQuickJSAsyncWASMModuleFromVariant(asyncVariant));
