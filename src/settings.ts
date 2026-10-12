/**
 * The platform alias users put in config.json (`"platform": "NimbioGates"`).
 *
 * Deliberately not `Nimbio`: an unofficial third-party `homebridge-nimbio`
 * already registers that alias, and two plugins claiming one alias forces users
 * to fully qualify it. A distinct alias lets both be installed side by side.
 */
export const PLATFORM_NAME = "NimbioGates";

/** Must match package.json `name`. */
export const PLUGIN_NAME = "@nimbio/homebridge-nimbio";
