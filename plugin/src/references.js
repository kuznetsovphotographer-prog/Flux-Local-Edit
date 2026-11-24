(function () {
  const LIMIT = 2;

  function list(value) {
    return (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean).slice(0, LIMIT);
  }

  async function upload(context, client, files, role) {
    const cache = context.referenceCache || {};
    if (!cache[role]) cache[role] = [];
    const names = cache[role];
    const check = () => context.throwIfCancelled(context.cancelToken);
    for (const [index, file] of files.entries()) {
      check();
      if (!names[index]) {
        const result = await client.uploadImage(file, role);
        check();
        if (!result.imageName) throw new Error(`Reference ${index + 1} upload did not return a filename.`);
        names[index] = result.imageName;
      }
    }
    return names.slice(0, files.length);
  }

  globalThis.LocalEditReferences = { LIMIT, list, upload };
})();
