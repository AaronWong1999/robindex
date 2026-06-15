const dns = require("node:dns");

const API_IP = process.env.CLOUDFLARE_API_IP || "104.18.22.21";
const originalLookup = dns.lookup;
const originalPromisesLookup = dns.promises.lookup.bind(dns.promises);

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (hostname === "api.cloudflare.com") {
    if (typeof options === "function") {
      return options(null, API_IP, 4);
    }
    if (options?.all) {
      return callback(null, [{ address: API_IP, family: 4 }]);
    }
    return callback(null, API_IP, 4);
  }
  return originalLookup.call(this, hostname, options, callback);
};

dns.promises.lookup = async function patchedPromisesLookup(hostname, options) {
  if (hostname === "api.cloudflare.com") {
    if (options?.all) return [{ address: API_IP, family: 4 }];
    return { address: API_IP, family: 4 };
  }
  return originalPromisesLookup(hostname, options);
};
