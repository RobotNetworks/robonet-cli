import type { Command } from "commander";

import {
  DEFAULT_SCOPES,
  requestClientCredentialsToken,
} from "../auth/client-credentials.js";
import { discoverOAuth } from "../auth/discovery.js";
import { performPkceLogin } from "../auth/pkce.js";
import {
  loadToken,
  saveToken,
  storedTokenFromClientCredentials,
  storedTokenFromPkceLogin,
} from "../auth/token-store.js";
import { loadConfig } from "../config.js";
import { renderKeyValues } from "../output/formatters.js";
import { renderJson } from "../output/json-output.js";
import {
  clientIdOption,
  clientSecretOption,
  jsonOption,
  profileTitle,
  resolveClientId,
  resolveClientSecret,
  scopeOption,
} from "./shared.js";

export function registerLoginCommand(program: Command): void {
  const loginCmd = program
    .command("login")
    .description("Manage local RoboNet login state")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .option("--resource <url>", "Override the discovered websocket resource")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.opts().profile);
      const discovery = await discoverOAuth(config.endpoints);
      const result = await performPkceLogin({
        endpoints: config.endpoints,
        discovery,
        scope: opts.scope,
      });
      const stored = storedTokenFromPkceLogin({
        token: result.token,
        tokenEndpoint: result.tokenEndpoint,
        clientId: result.clientId,
        refreshToken: result.refreshToken,
        redirectUri: result.redirectUri,
      });
      saveToken(config.tokenStoreFile, stored);

      const payload: Record<string, unknown> = {
        stored: true,
        auth_mode: stored.authMode,
        token_store_file: config.tokenStoreFile,
        token_endpoint: stored.tokenEndpoint,
        resource: stored.resource,
        client_id: stored.clientId,
        redirect_uri: stored.redirectUri,
        expires_in: stored.expiresIn,
        scope: stored.scope,
      };
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(profileTitle("RoboNet Login Stored", config), payload),
        );
      }
    });

  loginCmd
    .command("client-credentials")
    .description("Acquire and store a token using OAuth client_credentials")
    .addOption(clientIdOption())
    .addOption(clientSecretOption())
    .addOption(scopeOption())
    .option("--resource <url>", "Override the discovered websocket resource")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const discovery = await discoverOAuth(config.endpoints);
      const clientId = await resolveClientId(opts.clientId);
      const clientSecret = await resolveClientSecret(opts.clientSecret);
      const resource =
        opts.resource ??
        (discovery.websocketResource ?? discovery.apiResource ?? config.endpoints.apiBaseUrl.replace(/\/+$/, ""));

      const token = await requestClientCredentialsToken({
        tokenEndpoint: discovery.tokenEndpoint,
        clientId,
        clientSecret,
        resource,
        scope: opts.scope,
      });

      const stored = storedTokenFromClientCredentials(
        token,
        discovery.tokenEndpoint,
        clientId,
      );
      saveToken(config.tokenStoreFile, stored);

      const payload: Record<string, unknown> = {
        stored: true,
        token_store_file: config.tokenStoreFile,
        token_endpoint: discovery.tokenEndpoint,
        resource: stored.resource,
        client_id: stored.clientId,
        expires_in: stored.expiresIn,
        scope: stored.scope,
      };
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(profileTitle("RoboNet Login Stored", config), payload),
        );
      }
    });

  loginCmd
    .command("status")
    .description("Show the current stored authentication state")
    .addOption(jsonOption())
    .action(async (opts, cmd) => {
      const config = loadConfig(cmd.parent?.parent?.opts().profile);
      const stored = loadToken(config.tokenStoreFile);
      const payload: Record<string, unknown> = {
        configured: stored !== null,
        token_store_file: config.tokenStoreFile,
      };
      if (stored) {
        payload.auth_mode = stored.authMode;
        payload.client_id = stored.clientId;
        payload.resource = stored.resource;
        payload.token_endpoint = stored.tokenEndpoint;
        payload.expires_in = stored.expiresIn;
        payload.scope = stored.scope;
        payload.redirect_uri = stored.redirectUri;
      }
      if (opts.json) {
        console.log(renderJson(payload));
      } else {
        console.log(
          renderKeyValues(
            profileTitle("RoboNet Login Status", config),
            payload,
          ),
        );
      }
    });
}
