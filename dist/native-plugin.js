import { resolveAbsolutePath } from "./core/utils.js";
import { createCliMethodInvoker, registerCli } from "./native/cli.js";
import { createNativeHostBridge, registerGatewayMethods, registerLifecycleHooks, registerService } from "./native/runtime.js";
import { createLogger, prepareResolvedConfig, resolvePluginConfig } from "./native/shared.js";
import { createStepRollbackPlugin, manifest } from "./plugin.js";

export function createNativeStepRollbackPlugin(options = {}) {
  return {
    id: manifest.id,
    name: manifest.name,
    configSchema: manifest.configSchema,
    register(api) {
      const logger = createLogger(api);
      const rawConfig = {
        ...resolvePluginConfig(api, manifest.id),
        ...(options.config ?? {})
      };
      const config = prepareResolvedConfig(rawConfig, logger);
      const engine = createStepRollbackPlugin({
        config,
        logger,
        host: {
          ...createNativeHostBridge(api, logger, options),
          ...(options.host ?? {})
        }
      });
      const cliMethodInvoker = createCliMethodInvoker(api, engine, logger, {
        ...options,
        cliCwd: options.cliCwd ?? config.workspaceRoots[0] ?? resolveAbsolutePath("~")
      });

      registerGatewayMethods(api, engine, logger);
      registerLifecycleHooks(api, engine, logger);
      registerService(api, engine, logger);
      registerCli(api, engine, cliMethodInvoker);

      logger.debug?.(`[${manifest.id}] registered native OpenClaw plugin surfaces`);

      return engine;
    }
  };
}

export const nativeStepRollbackPlugin = createNativeStepRollbackPlugin();

export default nativeStepRollbackPlugin;
