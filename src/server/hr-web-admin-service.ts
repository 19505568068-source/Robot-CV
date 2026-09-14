import os from "node:os";

import QRCode from "qrcode";

import {
  HrWebStore,
  type HrWebSettings,
  type UpdateHrWebSettingsInput
} from "./hr-web-store.js";

export type HrWebEntrySummary = {
  enabled: boolean;
  configured: boolean;
  stableId: string;
  publicLink: string;
  qrContent: string;
  qrDataUrl?: string;
  listenerUrl: string;
  reachability: "public-https" | "local-network" | "this-device-only";
  validity: "until-rotated";
  validityNote: string;
  activeSessions: number;
};

export type HrWebAdminBootstrap = {
  settings: Omit<HrWebSettings, "entryToken">;
  entry: HrWebEntrySummary;
};

export type HrWebAdminServiceOptions = {
  store: HrWebStore;
  port: number;
  host?: string;
  listenerUrl: string;
  qrDataUrlFactory?: (content: string) => Promise<string>;
};

export class HrWebAdminService {
  private readonly qrDataUrlFactory: (content: string) => Promise<string>;

  constructor(private readonly options: HrWebAdminServiceOptions) {
    this.qrDataUrlFactory = options.qrDataUrlFactory ?? ((content) => QRCode.toDataURL(content, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#111816", light: "#ffffff" }
    }));
  }

  async getBootstrap(): Promise<HrWebAdminBootstrap> {
    const settings = this.options.store.getSettings();
    const { entryToken: _entryToken, ...publicSettings } = settings;
    const publicLink = this.entryUrl(settings);
    let qrDataUrl: string | undefined;
    try {
      qrDataUrl = await this.qrDataUrlFactory(publicLink);
    } catch {
      // The text link remains usable if local QR rendering fails.
    }
    const origin = new URL(publicLink).origin;
    const reachability = settings.publicBaseUrl?.startsWith("https://")
      ? "public-https" as const
      : isLoopbackHostname(new URL(origin).hostname)
        ? "this-device-only" as const
        : "local-network" as const;
    return {
      settings: publicSettings,
      entry: {
        enabled: settings.enabled,
        configured: settings.enabled,
        stableId: `h5-${settings.entryRevision}`,
        publicLink,
        qrContent: publicLink,
        ...(qrDataUrl ? { qrDataUrl } : {}),
        listenerUrl: this.options.listenerUrl,
        reachability,
        validity: "until-rotated",
        activeSessions: this.options.store.getSessionCount(),
        validityNote: reachability === "public-https"
          ? "固定公网 HTTPS 入口；仅在你主动更换二维码密钥后失效"
          : reachability === "local-network"
            ? "当前是同一局域网测试入口；IP 变化后需重新配置公网域名才能长期使用"
            : "当前只可在本机预览；请配置公网 HTTPS 地址或连接局域网"
      }
    };
  }

  async updateSettings(input: UpdateHrWebSettingsInput): Promise<HrWebAdminBootstrap> {
    this.options.store.updateSettings(input);
    return this.getBootstrap();
  }

  async rotateEntry(): Promise<HrWebAdminBootstrap> {
    this.options.store.rotateEntryToken();
    return this.getBootstrap();
  }

  private entryUrl(settings: HrWebSettings): string {
    const origin = settings.publicBaseUrl ?? localNetworkOrigin(this.options.host ?? "0.0.0.0", this.options.port);
    return `${origin.replace(/\/$/u, "")}/e/${encodeURIComponent(settings.entryToken)}`;
  }
}

function localNetworkOrigin(host: string, port: number): string {
  const advertised = wildcardHost(host) ? firstLanIpv4() ?? "127.0.0.1" : host;
  const formattedHost = advertised.includes(":") && !advertised.startsWith("[") ? `[${advertised}]` : advertised;
  return `http://${formattedHost}${port === 80 ? "" : `:${port}`}`;
}

function firstLanIpv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivateIpv4(address.address)) return address.address;
    }
  }
  return undefined;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function wildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || /^127\./u.test(normalized);
}
