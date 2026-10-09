import { createQuickJsEvaluator } from '../runtime/quickjs-evaluator.mjs';

let initialization;

/** Lazy sandboxed evaluator; guest code receives only the Code Mode capabilities. */
export function createNodeEvaluator() {
  let evaluate;
  return async (source, environment) => {
    environment.signal?.throwIfAborted();
    if (!evaluate) {
      const pending = initialization ??= Promise.all([
        import('quickjs-emscripten-core'),
        import('@jitl/quickjs-wasmfile-release-asyncify'),
      ]).then(([{ newQuickJSAsyncWASMModuleFromVariant }, { default: variant }]) =>
        newQuickJSAsyncWASMModuleFromVariant(variant));
      let module;
      try { module = await pending; }
      catch (error) { if (initialization === pending) initialization = undefined; throw error; }
      environment.signal?.throwIfAborted();
      evaluate ??= createQuickJsEvaluator(module);
    }
    return evaluate(source, environment);
  };
}
