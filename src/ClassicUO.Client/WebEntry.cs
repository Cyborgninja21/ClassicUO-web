// SPDX-License-Identifier: BSD-2-Clause
//
// Public entry point for the WASM/browser loader. `Bootstrap` is internal, so
// the out-of-assembly loader can't call Boot() directly; this thin public shim
// (same assembly, so it can reach internal Bootstrap) is the seam. Desktop
// builds are unaffected — nothing references this.
namespace ClassicUO
{
    public static class WebEntry
    {
        public static void Start(string[] args) => Bootstrap.Boot(null, args);
    }
}
