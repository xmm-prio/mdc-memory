/**
 * One dsh storage domain held open for the plugin's lifetime. Callers may ask
 * for it before it is mounted: they wait for the open, and fail with the open
 * error when it cannot be opened.
 */

/**
 * @param {object} spec - the domain declaration handed to `storageDomain.open`.
 */
export function createDomainSlot(spec) {
  let domain;
  let failure;
  const waiting = [];

  return {
    /**
     * Open the domain and release the callers waiting for it.
     * @param {object} storageDomain - the dsh `storageDomain` service.
     * @returns {Promise<() => Promise<void>>} closes the domain.
     */
    async mount(storageDomain) {
      let opened;
      try {
        opened = await storageDomain.open(spec);
      } catch (error) {
        failure = error;
        for (const { reject } of waiting.splice(0)) reject(error);
        throw error;
      }
      domain = opened;
      for (const { resolve } of waiting.splice(0)) resolve(opened);
      return async () => {
        domain = undefined;
        await opened.close();
      };
    },
    /** @returns {Promise<object>} the open domain. */
    opened() {
      if (domain) return Promise.resolve(domain);
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}
