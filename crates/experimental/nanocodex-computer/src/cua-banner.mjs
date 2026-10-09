// The provider runs this bootstrap again after every REPL reset. Keep the
// signed upstream bundle untouched and use its public observation options.
await import('@oai/cua/tinyskyAlt');

{
  const bound = new WeakSet();
  const fullSnapshots = target => {
    if (bound.has(target)) return target;
    bound.add(target);
    for (const name of ['getAXState', 'getAXStateAndScreenshot']) {
      const observe = target[name];
      if (typeof observe !== 'function') continue;
      target[name] = function (options) {
        return observe.call(this, { disableDiffing: true, ...options });
      };
    }
    return target;
  };
  for (const name of ['getApp', 'getTab', 'createBrowserTab']) {
    const bind = cua[name];
    if (typeof bind !== 'function') continue;
    cua[name] = async function (...args) {
      return fullSnapshots(await bind.apply(this, args));
    };
  }

  const guidance = () => nodeRepl.write('Nanocodex observation default: getAXState() and getAXStateAndScreenshot() return a full current accessibility tree. This overrides the upstream preference for diffs. Explicit disableDiffing: false opts into diffs. Always derive element indices from the latest observation; a full tree does not prevent the app from changing afterward.');
  const rewrite = cua.rewriteDocumentation;
  cua.rewriteDocumentation = async function (...args) {
    await rewrite.apply(this, args);
    guidance();
  };
  guidance();
}
