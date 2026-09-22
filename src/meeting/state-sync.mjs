/** Remote changes win this tick; a successful local write becomes the baseline.
 * Never acknowledge a remote change until the page's gate actually accepts it.
 */
export function createStateSync() {
  let lastRemote = null;
  return {
    async sync({ remote, local, apply, push }) {
      if (!["open", "asleep"].includes(remote)) return;
      if (remote !== lastRemote) {
        if (remote === local || await apply(remote)) lastRemote = remote;
        return; // local was sampled BEFORE apply; it must not echo back.
      }
      if (["open", "asleep"].includes(local) && local !== lastRemote) {
        if (await push(local)) lastRemote = local;
      }
    },
  };
}
