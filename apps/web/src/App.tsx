import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, type ViewKey } from "./components/AppShell";
import { AdminConsole, type AdminConsoleApi } from "./components/AdminConsole";
import { AgentWorkspaceConsole } from "./components/AgentWorkspaceConsole";
import { AuthScreen, ForcedPasswordScreen } from "./components/AuthScreen";
import { ChatWorkspace } from "./components/ChatWorkspace";
import type { MemoryManagerApi } from "./components/MemoryManager";
import {
  DocumentAssistantWorkspace,
  type DraftImportPayload,
} from "./components/DocumentAssistantWorkspace";
import { LibraryConsole } from "./components/LibraryConsole";
import {
  PlatformConsole,
  type PlatformConsoleActions,
} from "./components/PlatformConsole";
import { AutomationsConsole } from "./components/AutomationsConsole";
import { PwaInstallPrompt } from "./components/PwaInstallPrompt";
import { SessionRestoreScreen } from "./components/SessionRestoreScreen";
import { FirstRunWelcome } from "./components/FirstRunWelcome";
import {
  createAdminConnectorConfig,
  bulkCreateAdminGroups,
  bulkDeleteAdminGroups,
  createAdminGroup,
  createAdminToolConfig,
  createAdminContentFilter,
  updateAdminContentFilter,
  deleteAdminContentFilter,
  listAdminContentFilters,
  previewAdminContentFilter,
  updateAdminModelContentFilters,
  previewAdminToolScript,
  createAdminUser,
  approveAdminAccessRequest,
  declineAdminAccessRequest,
  bootstrapPlatformOwner,
  deleteAdminGroup,
  createProviderKey,
  createPlatformProvider,
  deleteAdminToolConfig,
  deletePlatformProvider,
  deleteProviderKey,
  demoFallbackEnabled,
  loadBootstrap,
  loadAuthOptions,
  listAdminAuditEvents,
  listAdminModelAccess,
  listAdminPromptActivity,
  listAdminSecurityAlerts,
  getAdminUsageSummary,
  listAdminUsageRecords,
  listAdminAlertRules,
  createAdminAlertRule,
  updateAdminAlertRule,
  deleteAdminAlertRule,
  listAdminAlertNotifications,
  setAdminAlertNotificationArchived,
  getAdminAlertEmailStatus,
  listPlatformAuditEvents,
  listPlatformPromptActivity,
  listPlatformSecurityAlerts,
  getPlatformUsageSummary,
  listPlatformUsageRecords,
  listPlatformAlertRules,
  createPlatformAlertRule,
  updatePlatformAlertRule,
  deletePlatformAlertRule,
  listPlatformAlertNotifications,
  setPlatformAlertNotificationArchived,
  getPlatformEmailSettings,
  updatePlatformEmailSettings,
  sendPlatformEmailTest,
  getPlatformElasticStatus,
  getPlatformSettings,
  updatePlatformSecurityAlert,
  updateAdminSecurityAlert,
  createMemory,
  deleteMemory,
  getAdminRetentionPolicy,
  listAdminChatFeedback,
  listAdminIssueReports,
  getAdminIssueReportScreenshot,
  getMemoryPolicy,
  getMemoryStats,
  listAdminRetentionThreads,
  runAdminRetentionBatch,
  updateAdminRetentionPolicy,
  listMemories,
  purgeMemories,
  purgeUserMemories,
  updateMemory,
  updateMemoryPolicy,
  updateMemorySettings,
  updatePlatformSettings,
  updatePlatformTenantBranding,
  loginWithAuth,
  completePresessionMfaChallenge,
  markFirstRunGuideSeen,
  resetAdminUserPassword,
  resumeSession,
  revokeSession,
  getSessionToken,
  setSessionToken,
  mapConnectorConfigRecordToConnector,
  mapSsoConfigRecordToDisplay,
  mapToolConfigRecordToDisplay,
  updateAdminConnectorConfig,
  testAdminConnectorConfig,
  connectorOAuthStartUrl,
  updateAdminGroup,
  updateAdminModelAccess,
  updateAdminSsoConfig,
  createAdminSsoConfig,
  deleteAdminSsoConfig,
  testAdminSsoConfig,
  updateAdminToolConfig,
  updateAdminUser,
  ChatRequestError,
  updatePlatformModel,
  updatePlatformProvider,
  updatePlatformConnector,
  deactivateAdminUser,
  deleteAdminUser,
  revealProviderKey,
  rotateProviderKey,
  syncAdminModelAccess,
  syncProviderModels,
  updateAccountPassword,
  updateAccountProfile,
  loadAccountApiKey,
  createAccountApiKey,
  revokeAccountApiKey,
  submitIssueReport,
} from "./lib/api";
import { useChatStore } from "./lib/chatStore";
import { markdownToPlainText } from "./lib/markdown";
import { useGlobalTooltip } from "./lib/useGlobalTooltip";
import {
  detectMobilePlatform,
  getCapturedInstallPrompt,
  isRunningStandalone,
  subscribeToInstallPrompt,
  type MobilePlatform,
} from "./lib/pwa";
import type {
  AccountPasswordUpdateRequest,
  AccountProfileUpdateRequest,
  AccountApiKeyCreateResponse,
  AccountApiKeyStatus,
  AuthBootstrapOwnerRequest,
  AuthLoginRequest,
  AuthOptionsResponse,
  BootstrapData,
  ChatMessage,
  Connector,
  ModelConfig,
  PlatformModelUpdateRequest,
  Role,
  User,
} from "./lib/types";
import { ConnectorUpdateError, connectorUsesCredentialRecord } from "./components/ConnectorsPanel";
import { applyBrandTheme, cacheBrandBoot } from "./lib/brandTheme";
import { appendChatCitationsForDraft } from "./lib/draftCitations";
import type { DraftNavigationGuard } from "./lib/draftNavigation";
import { sampleData } from "./data/sampleData";

const SESSION_STORAGE_KEY = "aperture-session-user-id";
const DARK_MODE_STORAGE_KEY = "aperture-dark-mode";
const PWA_INSTALL_DISMISSED_KEY = "aperture-pwa-install-dismissed";
const DEFAULT_FAVICON_HREF = "/favicon.svg";
const PERSONA_ALIASES: Record<string, string> = {
  owner: "user-owner",
  "platform-owner": "user-owner",
  admin: "user-admin",
};

/* Every role lands on the default chat view after sign-in. The first-run
 * request only records the durable seen marker; guides stay manual via the
 * Help and Documentation controls. */
type FirstRunGuideRequest = {
  userId: string;
};

export function App() {
  useGlobalTooltip();
  const [sessionUserId, setSessionUserId] = useState<string | null>(() =>
    readInitialSessionUserId(),
  );
  const [data, setData] = useState<BootstrapData>(sampleData);
  const [view, setView] = useState<ViewKey>("chat");
  const [libraryTab, setLibraryTab] = useState<"knowledge" | "tools">("knowledge");
  const [agentsSection, setAgentsSection] = useState<"agents" | "automations">("agents");
  const [draftSessionKey, setDraftSessionKey] = useState(0);
  const [draftImport, setDraftImport] = useState<DraftImportPayload | null>(null);
  /** Server draft id a search hit asked to open fully loaded in the Drafter. */
  const [draftOpenServerId, setDraftOpenServerId] = useState<string | null>(null);
  const draftNavigationGuardRef = useRef<DraftNavigationGuard | null>(null);
  const registerDraftNavigationGuard = useCallback((guard: DraftNavigationGuard | null) => {
    draftNavigationGuardRef.current = guard;
  }, []);
  // Only voluntary navigation uses this guard. Session invalidation and
  // security-driven sign-out must never depend on saving a local document.
  const requestWorkspaceNavigation = useCallback((label: string, proceed: () => void) => {
    const guard = draftNavigationGuardRef.current;
    if (guard) guard(label, proceed);
    else proceed();
  }, []);
  const [requestedAgentId, setRequestedAgentId] = useState<string | null>(null);
  const [helpDrawerRequestKey, setHelpDrawerRequestKey] = useState(0);
  const [adminDocumentationRequestKey, setAdminDocumentationRequestKey] = useState(0);
  const [ownerDocumentationRequestKey, setOwnerDocumentationRequestKey] = useState(0);
  const [platformSetupRequestKey, setPlatformSetupRequestKey] = useState(0);
  const [firstRunGuideRequest, setFirstRunGuideRequest] = useState<FirstRunGuideRequest | null>(null);
  const [pwaInstallPlatform, setPwaInstallPlatform] = useState<MobilePlatform | null>(null);
  /* Which mobile OS this browser tab runs on, or null on desktop and inside
   * the installed app. Gates the persistent sidebar install entry point. */
  const [mobileInstallTarget] = useState<MobilePlatform | null>(() =>
    isRunningStandalone() ? null : detectMobilePlatform(),
  );
  const [viewAsRole, setViewAsRole] = useState<Role | null>(null);
  const [darkMode, setDarkMode] = useState(() =>
    readBooleanPreference(DARK_MODE_STORAGE_KEY, false),
  );
  const [loading, setLoading] = useState(false);
  /* True once the signed-in account's real bootstrap data is in `data`. Until
   * then `data` still holds the bundled sample workspace, whose placeholder
   * identity must never be painted as the active account. */
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [appNotice, setAppNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const [authOptions, setAuthOptions] = useState<AuthOptionsResponse | null>(
    null,
  );
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signOutNotice, setSignOutNotice] = useState<string | null>(null);
  const [authOptionsAttempt, setAuthOptionsAttempt] = useState(0);
  /* Set when a temporary-password sign-in succeeded and the account must
   * choose its own password before the workspace loads. */
  const [pendingPasswordChange, setPendingPasswordChange] = useState<{
    result: Awaited<ReturnType<typeof loginWithAuth>>;
    currentPassword: string;
  } | null>(null);

  const effectiveRole = viewAsRole ?? data.me.role;
  const effectiveData = useMemo(
    () => dataForRolePreview(data, effectiveRole),
    [data, effectiveRole],
  );
  const chat = useChatStore(sessionUserId ?? "signed-out", effectiveData, {
    enabled: Boolean(sessionUserId),
  });

  const queueFirstRunGuide = useCallback((user: User) => {
    if (user.first_run_guide_seen_at) return;
    setFirstRunGuideRequest({ userId: user.id });
  }, []);

  useEffect(() => {
    /* Theme the document root as well as AppShell. SelectControl menus and
     * other fixed overlays are portaled to <body>, outside the shell, and
     * native form popups read color-scheme from the document tree. */
    document.documentElement.classList.toggle("theme-dark", darkMode);
    return () => document.documentElement.classList.remove("theme-dark");
  }, [darkMode]);

  useEffect(() => {
    const tenant = effectiveData.currentTenant;
    const brandName = tenant.chat_brand_name?.trim() || "Aperture Chat";
    const faviconHref =
      tenant.icon_url?.trim() ||
      tenant.logo_url?.trim() ||
      DEFAULT_FAVICON_HREF;
    document.title = brandName;

    let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }
    favicon.href = faviconHref;
    favicon.type = faviconHref.endsWith(".svg") ? "image/svg+xml" : "";

    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (themeColor) {
      themeColor.content = tenant.primary_color;
    }

    /* iOS reads this meta (not the manifest) for the home-screen label. */
    const appTitle = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );
    if (appTitle) {
      appTitle.content = brandName;
    }

    applyBrandTheme(tenant);
    cacheBrandBoot({
      name: brandName,
      favicon: faviconHref,
      primary_color: tenant.primary_color,
      gradient_start: tenant.gradient_start,
      gradient_end: tenant.gradient_end,
      text_color: tenant.text_color,
    });
  }, [
    effectiveData.currentTenant.chat_brand_name,
    effectiveData.currentTenant.icon_url,
    effectiveData.currentTenant.logo_url,
    effectiveData.currentTenant.primary_color,
    effectiveData.currentTenant.gradient_start,
    effectiveData.currentTenant.gradient_end,
    effectiveData.currentTenant.text_color,
  ]);

  useEffect(() => {
    if (sessionUserId) return;
    let active = true;
    setAuthLoading(true);
    setAuthError(null);
    loadAuthOptions()
      .then((options) => {
        if (!active) return;
        setAuthOptions(options);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuthError(
          error instanceof Error
            ? error.message
            : "Could not load sign-in configuration.",
        );
        setAuthOptions(null);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionUserId, authOptionsAttempt]);

  useEffect(() => {
    if (!sessionUserId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setBootstrapError(null);
    persistSessionUserId(sessionUserId);
    // When a signed session token is stored, resume through /api/auth/session
    // so the API rotates it: each visit inside the TTL extends the session
    // instead of counting down to the original login's absolute expiry.
    const storedSessionToken = getSessionToken();
    const bootstrapLoad = storedSessionToken
      ? resumeSession(storedSessionToken).then((result) => {
          if (active && result.session?.token) {
            setSessionToken(result.session.token);
          }
          return result.bootstrap;
        })
      : loadBootstrap(sessionUserId);
    bootstrapLoad
      .then((loaded) => {
        if (!active) return;
        setData(loaded);
        setSessionHydrated(true);
        setBootstrapError(null);
        setView((current) => resolveViewForRole(current, loaded.me.role));
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isInactiveSessionError(error)) {
          clearSessionUserId();
          setSessionToken(null);
          clearPersonaQueryParam();
          setSessionUserId(null);
          setData(sampleData);
          setSessionHydrated(false);
          setView("chat");
          setViewAsRole(null);
          setAuthError(null);
          setBootstrapError(null);
          return;
        }
        setBootstrapError(
          error instanceof Error
            ? error.message
            : "Could not load platform configuration.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionUserId, bootstrapAttempt]);

  // Finish an SSO sign-in when the OIDC callback redirected back with a session
  // token (or an honest error) in the URL fragment.
  useEffect(() => {
    const connectorReturn = consumeConnectorOAuthReturn();
    if (connectorReturn) {
      setAppNotice({
        tone: connectorReturn.success ? "success" : "warning",
        message: connectorReturn.message,
      });
    }
    const ssoReturn = consumeSsoReturnFragment();
    if (!ssoReturn) return;
    if (ssoReturn.error) {
      setAuthError(ssoReturn.error);
      return;
    }
    if (ssoReturn.mfaChallengeToken) {
      // The OIDC callback finished primary sign-in but left a pre-session MFA
      // challenge (#sso_mfa=...). The fragment is already stripped from the
      // URL; restore the server's challenge state through the AuthScreen
      // challenge view. Only the verified login response ever reaches the
      // session store below.
      let mfaActive = true;
      setAuthLoading(true);
      setAuthError(null);
      completePresessionMfaChallenge(ssoReturn.mfaChallengeToken)
        .then((result) => {
          if (!mfaActive) return;
          setSessionToken(result.session?.token ?? null);
          persistSessionUserId(result.user.id);
          setSessionUserId(result.user.id);
          setData(result.bootstrap);
          setSessionHydrated(true);
          setViewAsRole(null);
          setView("chat");
          setBootstrapError(null);
          queueFirstRunGuide(result.bootstrap.me);
        })
        .catch((error: unknown) => {
          if (!mfaActive) return;
          setAuthError(
            error instanceof Error ? error.message : "Multi-factor sign-in could not be completed.",
          );
        })
        .finally(() => {
          if (mfaActive) setAuthLoading(false);
        });
      return () => {
        mfaActive = false;
      };
    }
    if (!ssoReturn.token) return;
    let active = true;
    setAuthLoading(true);
    setAuthError(null);
    setSessionToken(ssoReturn.token);
    resumeSession(ssoReturn.token)
      .then((result) => {
        if (!active) return;
        persistSessionUserId(result.user.id);
        setSessionUserId(result.user.id);
        setData(result.bootstrap);
        setSessionHydrated(true);
        setViewAsRole(null);
        setView("chat");
        setBootstrapError(null);
        queueFirstRunGuide(result.bootstrap.me);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSessionToken(null);
        setAuthError(error instanceof Error ? error.message : "SSO sign-in could not be completed.");
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, [queueFirstRunGuide]);

  const handleAuthLogin = useCallback(async (payload: AuthLoginRequest) => {
    setAuthLoading(true);
    setAuthError(null);
    setSignOutNotice(null);
    try {
      const result = await loginWithAuth(payload);
      setSessionToken(result.session?.token ?? null);
      if (result.must_change_password && payload.password) {
        /* Temporary password: hold the sign-in until the account sets its own.
         * Nothing is persisted yet, so a reload honestly lands back at sign-in. */
        setPendingPasswordChange({ result, currentPassword: payload.password });
        return;
      }
      persistSessionUserId(result.user.id);
      setSessionUserId(result.user.id);
      setData(result.bootstrap);
      setSessionHydrated(true);
      setViewAsRole(null);
      setView("chat");
      setBootstrapError(null);
      queueFirstRunGuide(result.bootstrap.me);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setAuthLoading(false);
    }
  }, [queueFirstRunGuide]);

  const completeForcedPasswordChange = useCallback(
    async (newPassword: string) => {
      if (!pendingPasswordChange) return;
      const { result, currentPassword } = pendingPasswordChange;
      await updateAccountPassword(result.user.id, {
        current_password: currentPassword,
        new_password: newPassword,
      });
      persistSessionUserId(result.user.id);
      setSessionUserId(result.user.id);
      setData(result.bootstrap);
      setSessionHydrated(true);
      setViewAsRole(null);
      setView("chat");
      setBootstrapError(null);
      setPendingPasswordChange(null);
      queueFirstRunGuide(result.bootstrap.me);
    },
    [pendingPasswordChange, queueFirstRunGuide],
  );

  const cancelForcedPasswordChange = useCallback(() => {
    setPendingPasswordChange(null);
    setSessionToken(null);
  }, []);

  const handleBootstrapOwner = useCallback(async (payload: AuthBootstrapOwnerRequest) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const result = await bootstrapPlatformOwner(payload);
      setSessionToken(result.session?.token ?? null);
      persistSessionUserId(result.user.id);
      setSessionUserId(result.user.id);
      setData(result.bootstrap);
      setSessionHydrated(true);
      setViewAsRole(null);
      setView("platform");
      setBootstrapError(null);
      queueFirstRunGuide(result.bootstrap.me);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "First-owner setup failed.");
    } finally {
      setAuthLoading(false);
    }
  }, [queueFirstRunGuide]);


  const handleSignOut = useCallback(() => {
    const endedToken = getSessionToken();
    clearSessionUserId();
    setSessionToken(null);
    setSessionUserId(null);
    setData(sampleData);
    setSessionHydrated(false);
    setView("chat");
    setViewAsRole(null);
    setBootstrapError(null);
    setAuthError(null);
    setSignOutNotice(null);
    setLoading(false);
    // Local cleanup must succeed offline. A captured token lets the server
    // revoke this family without touching a later sign-in or MFA replacement.
    if (endedToken) {
      void revokeSession(endedToken).catch(() => {
        if (getSessionToken() === null) {
          setSignOutNotice("Signed out on this device. The server could not confirm that the session was revoked.");
        }
      });
    }
  }, []);

  const requestSignOut = useCallback(() => {
    requestWorkspaceNavigation("sign out", handleSignOut);
  }, [handleSignOut, requestWorkspaceNavigation]);

  const handleToggleDarkMode = useCallback(() => {
    setDarkMode((current) => {
      const next = !current;
      persistBooleanPreference(DARK_MODE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const handleAccountProfileUpdate = useCallback(
    async (payload: AccountProfileUpdateRequest) => {
      if (!sessionUserId) throw new Error("Sign in before updating your profile.");
      const updatedUser = await updateAccountProfile(sessionUserId, payload);
      setData((current) => replaceBootstrapUser(current, updatedUser));
      return updatedUser;
    },
    [sessionUserId],
  );

  const handleAccountPasswordUpdate = useCallback(
    async (payload: AccountPasswordUpdateRequest) => {
      if (!sessionUserId) throw new Error("Sign in before updating your password.");
      await updateAccountPassword(sessionUserId, payload);
    },
    [sessionUserId],
  );

  const handleAccountApiKeyLoad = useCallback(async (): Promise<AccountApiKeyStatus> => {
    if (!sessionUserId) throw new Error("Sign in before managing an API key.");
    return loadAccountApiKey(sessionUserId);
  }, [sessionUserId]);

  const handleAccountApiKeyCreate = useCallback(async (): Promise<AccountApiKeyCreateResponse> => {
    if (!sessionUserId) throw new Error("Sign in before creating an API key.");
    return createAccountApiKey(sessionUserId);
  }, [sessionUserId]);

  const handleAccountApiKeyRevoke = useCallback(async (): Promise<AccountApiKeyStatus> => {
    if (!sessionUserId) throw new Error("Sign in before revoking an API key.");
    return revokeAccountApiKey(sessionUserId);
  }, [sessionUserId]);

  useEffect(() => {
    setViewAsRole((current) => {
      if (!current) return null;
      if (current === data.me.role) return null;
      return previewRolesFor(data.me.role).includes(current) ? current : null;
    });
  }, [data.me.role]);

  useEffect(() => {
    setView((current) => resolveViewForRole(current, effectiveData.me.role));
  }, [effectiveData.me.role]);

  const acknowledgeFirstRun = useCallback(() => {
    if (!sessionUserId || !firstRunGuideRequest) return;
    if (firstRunGuideRequest.userId !== data.me.id) return;
    if (data.me.first_run_guide_seen_at) {
      setFirstRunGuideRequest(null);
      return;
    }

    void markFirstRunGuideSeen(firstRunGuideRequest.userId)
      .then((updatedUser) => {
        setData((current) => replaceBootstrapUser(current, updatedUser));
      })
      .catch(() => {
        // Keep the current visit unobstructed; the server will offer the
        // welcome again next sign-in if this preference could not be saved.
      });

    setFirstRunGuideRequest(null);
  }, [data.me.first_run_guide_seen_at, data.me.id, firstRunGuideRequest, sessionUserId]);

  useEffect(() => {
    /* Offer a home-screen install to signed-in phone users. iOS can show its
     * guidance immediately; Android waits for the browser to confirm the app
     * is genuinely installable (beforeinstallprompt), so the Install button
     * always triggers a real native install sheet. */
    if (!sessionUserId) {
      setPwaInstallPlatform(null);
      return;
    }
    if (readBooleanPreference(PWA_INSTALL_DISMISSED_KEY, false)) return;
    if (isRunningStandalone()) return;
    const platform = detectMobilePlatform();
    if (!platform) return;
    if (platform === "ios") {
      setPwaInstallPlatform("ios");
      return;
    }
    if (getCapturedInstallPrompt()) {
      setPwaInstallPlatform("android");
      return;
    }
    return subscribeToInstallPrompt(() => {
      setPwaInstallPlatform(getCapturedInstallPrompt() ? "android" : null);
    });
  }, [sessionUserId]);

  const dismissPwaInstallPrompt = useCallback(() => {
    persistBooleanPreference(PWA_INSTALL_DISMISSED_KEY, true);
    setPwaInstallPlatform(null);
  }, []);

  /* Manual reopen from the sidebar — deliberately ignores the dismissed flag
   * so users can come back to install weeks later. */
  const openPwaInstallPrompt = useCallback(() => {
    if (mobileInstallTarget) setPwaInstallPlatform(mobileInstallTarget);
  }, [mobileInstallTarget]);

  const openChat = useCallback(
    (id: string) => {
      requestWorkspaceNavigation("open another chat", () => {
        chat.selectThread(id);
        setView("chat");
      });
    },
    [chat, requestWorkspaceNavigation],
  );

  const startNewChat = useCallback(() => {
    requestWorkspaceNavigation("start a new chat", () => {
      chat.newChat();
      setView("chat");
    });
  }, [chat, requestWorkspaceNavigation]);

  const handleViewChange = useCallback((nextView: ViewKey) => {
    requestWorkspaceNavigation(nextView === "drafts" ? "start a new draft" : "leave Drafts", () => {
      if (nextView === "drafts") {
        setDraftImport(null);
        setDraftOpenServerId(null);
        setDraftSessionKey((current) => current + 1);
      }
      setView(nextView);
    });
  }, [requestWorkspaceNavigation]);

  /** A draft search hit opens that document loaded, not a blank workspace. */
  const handleOpenDraftFromSearch = useCallback((draftId: string) => {
    requestWorkspaceNavigation("open another draft", () => {
      setDraftImport(null);
      setDraftOpenServerId(draftId);
      setDraftSessionKey((current) => current + 1);
      setView("drafts");
    });
  }, [requestWorkspaceNavigation]);

  const openHelpDrawer = useCallback(() => {
    setHelpDrawerRequestKey((current) => current + 1);
  }, []);

  const openAdminDocumentation = useCallback(() => {
    requestWorkspaceNavigation("open the administrator guide", () => {
      setView("admin");
      setAdminDocumentationRequestKey((current) => current + 1);
    });
  }, [requestWorkspaceNavigation]);

  const handleTransferToDraft = useCallback(
    (message: ChatMessage) => {
      const threadTitle = chat.activeThread?.title ?? "Chat response";
      const title = transferredDraftTitle(threadTitle, message.content);
      setDraftOpenServerId(null);
      setDraftImport({
        id: `${message.id}-${Date.now()}`,
        title,
        content: appendChatCitationsForDraft(message.content, message.citations),
        sourceLabel: threadTitle === "New chat" ? "Chat response" : threadTitle,
        createdAt: message.createdAt,
        createdAtIso: message.completedAt || message.createdAtIso || message.executedAt,
      });
      setDraftSessionKey((current) => current + 1);
      setView("drafts");
    },
    [chat.activeThread?.title],
  );

  const adminApi = useMemo<AdminConsoleApi>(
    () => ({
      createUser: (actorUserId, payload) =>
        createAdminUser(actorUserId, payload),
      approveAccessRequest: (actorUserId, userId, role) =>
        approveAdminAccessRequest(actorUserId, userId, role),
      declineAccessRequest: (actorUserId, userId) =>
        declineAdminAccessRequest(actorUserId, userId),
      updateUser: (actorUserId, userId, patch) =>
        updateAdminUser(actorUserId, userId, patch),
      deactivateUser: async (actorUserId, userId) => {
        await deactivateAdminUser(actorUserId, userId);
      },
      deleteUser: async (actorUserId, userId) => {
        await deleteAdminUser(actorUserId, userId);
      },
      resetUserPassword: async (actorUserId, userId, payload) => {
        await resetAdminUserPassword(actorUserId, userId, payload);
      },
      createGroup: (actorUserId, payload) =>
        createAdminGroup(actorUserId, payload),
      createGroups: (actorUserId, payload) =>
        bulkCreateAdminGroups(actorUserId, payload),
      updateGroup: (actorUserId, groupId, patch) =>
        updateAdminGroup(actorUserId, groupId, patch),
      deleteGroup: async (actorUserId, groupId) => {
        await deleteAdminGroup(actorUserId, groupId);
      },
      deleteGroups: async (actorUserId, groupIds) => {
        const result = await bulkDeleteAdminGroups(actorUserId, {
          group_ids: groupIds,
        });
        return result.deleted_group_ids;
      },
      updateModelAccess: (actorUserId, modelId, patch) =>
        updateAdminModelAccess(actorUserId, modelId, patch),
      listModelAccess: (actorUserId) => listAdminModelAccess(actorUserId),
      syncModelAccess: (actorUserId) => syncAdminModelAccess(actorUserId),
      listContentFilters: (actorUserId) => listAdminContentFilters(actorUserId),
      createContentFilter: (actorUserId, payload) => createAdminContentFilter(actorUserId, payload),
      updateContentFilter: (actorUserId, filterId, payload) =>
        updateAdminContentFilter(actorUserId, filterId, payload),
      deleteContentFilter: async (actorUserId, filterId) => {
        await deleteAdminContentFilter(actorUserId, filterId);
      },
      previewContentFilter: (actorUserId, payload) => previewAdminContentFilter(actorUserId, payload),
      setModelContentFilters: (actorUserId, modelId, contentFilterIds) =>
        updateAdminModelContentFilters(actorUserId, modelId, contentFilterIds),
      createToolConfig: (actorUserId, payload) => createAdminToolConfig(actorUserId, payload),
      updateToolConfig: (actorUserId, toolId, payload) => updateAdminToolConfig(actorUserId, toolId, payload),
      deleteToolConfig: async (actorUserId, toolId) => {
        await deleteAdminToolConfig(actorUserId, toolId);
      },
      previewToolScript: (actorUserId, payload) => previewAdminToolScript(actorUserId, payload),
      setToolEnabled: async (actorUserId, _toolId, enabled, context) => {
        const record = await updateAdminToolConfig(
          actorUserId,
          context.tool.id,
          {
            enabled,
            endpoint_url: context.tool.endpoint,
            settings: {
              description: context.tool.description,
              scopes: context.tool.scopes,
              connected_model_ids: context.tool.connected_model_ids,
              status: enabled ? "ready" : "draft",
            },
          },
        );
        return mapToolConfigRecordToDisplay(record);
      },
      setSsoEnforced: async (actorUserId, configId, enforced, context) => {
        // "Enforce" only flips settings.enforced. The provider stays enabled so
        // SSO sign-in keeps working; disabling enforcement re-allows local login.
        const record = await updateAdminSsoConfig(actorUserId, configId, {
          enabled: true,
          settings: {
            enforced,
            status: enforced ? "enforced" : "ready",
            domains: context.config.domains,
            last_tested: "Saved now",
            admin_notes: context.config.admin_notes,
          },
        });
        return mapSsoConfigRecordToDisplay(record);
      },
      createSsoConfig: async (actorUserId, payload) => {
        const record = await createAdminSsoConfig(actorUserId, payload);
        return mapSsoConfigRecordToDisplay(record);
      },
      updateSsoConfig: async (actorUserId, configId, payload) => {
        const record = await updateAdminSsoConfig(actorUserId, configId, payload);
        return mapSsoConfigRecordToDisplay(record);
      },
      deleteSsoConfig: async (actorUserId, configId) => {
        await deleteAdminSsoConfig(actorUserId, configId);
      },
      testSsoConfig: (actorUserId, configId) => testAdminSsoConfig(actorUserId, configId),
      listAuditEvents: (actorUserId) => listAdminAuditEvents(actorUserId),
      listPromptActivity: (actorUserId, targetUserId) =>
        listAdminPromptActivity(actorUserId, { targetUserId, limit: 150 }),
      // Fetches one thread's full conversation for the audit preview; 500 is
      // the server-side maximum page size.
      listThreadPromptActivity: (actorUserId, threadId) =>
        listAdminPromptActivity(actorUserId, { threadId, limit: 500 }),
      listSecurityAlerts: (actorUserId, targetUserId) =>
        listAdminSecurityAlerts(actorUserId, {
          targetUserId,
          includeAcknowledged: true,
          limit: 150,
        }),
      acknowledgeSecurityAlert: (actorUserId, alertId, acknowledged) =>
        updateAdminSecurityAlert(actorUserId, alertId, { acknowledged }),
      getUsageSummary: (actorUserId, options) => getAdminUsageSummary(actorUserId, options),
      listUsageRecords: (actorUserId, targetUserId) =>
        listAdminUsageRecords(actorUserId, { targetUserId, limit: 500 }),
      listAlertRules: (actorUserId) => listAdminAlertRules(actorUserId),
      createAlertRule: (actorUserId, payload) => createAdminAlertRule(actorUserId, payload),
      updateAlertRule: (actorUserId, ruleId, patch) =>
        updateAdminAlertRule(actorUserId, ruleId, patch),
      deleteAlertRule: (actorUserId, ruleId) => deleteAdminAlertRule(actorUserId, ruleId),
      listAlertNotifications: (actorUserId) =>
        listAdminAlertNotifications(actorUserId, { limit: 200 }),
      setAlertNotificationArchived: (actorUserId, notificationId, archived) =>
        setAdminAlertNotificationArchived(actorUserId, notificationId, archived),
      getAlertEmailStatus: (actorUserId) => getAdminAlertEmailStatus(actorUserId),
      getMemoryPolicy: (actorUserId) => getMemoryPolicy(actorUserId),
      updateMemoryPolicy: (actorUserId, patch) => updateMemoryPolicy(actorUserId, patch),
      getMemoryStats: (actorUserId) => getMemoryStats(actorUserId),
      purgeUserMemories: (actorUserId, userId) => purgeUserMemories(actorUserId, userId),
      listChatFeedback: (actorUserId) => listAdminChatFeedback(actorUserId, { limit: 500 }),
      listIssueReports: (actorUserId) => listAdminIssueReports(actorUserId, { limit: 500 }),
      loadIssueReportScreenshot: (actorUserId, reportId) =>
        getAdminIssueReportScreenshot(actorUserId, reportId),
      getRetentionPolicy: (actorUserId) => getAdminRetentionPolicy(actorUserId),
      updateRetentionPolicy: (actorUserId, patch) => updateAdminRetentionPolicy(actorUserId, patch),
      listRetentionThreads: (actorUserId) => listAdminRetentionThreads(actorUserId, { limit: 500 }),
      runRetentionBatch: (actorUserId, payload) => runAdminRetentionBatch(actorUserId, payload),
    }),
    [],
  );

  // Memory content is fetched lazily and only for the signed-in user; it never
  // rides along in the bootstrap payload.
  const memoryApi = useMemo<MemoryManagerApi>(
    () => ({
      list: () => listMemories(data.me.id),
      create: (payload) => createMemory(data.me.id, payload),
      update: (memoryId, patch) => updateMemory(data.me.id, memoryId, patch),
      remove: (memoryId) => deleteMemory(data.me.id, memoryId),
      purge: () => purgeMemories(data.me.id),
      updateSettings: (patch) => updateMemorySettings(data.me.id, patch),
    }),
    [data.me.id],
  );

  const platformActions = useMemo<PlatformConsoleActions>(
    () => ({
      createProvider: (provider) =>
        createPlatformProvider(data.me.id, {
          id: provider.id,
          name: provider.name,
          kind: provider.kind,
          region: provider.region,
          base_url: provider.base_url ?? undefined,
          auth_type: provider.auth_type ?? undefined,
          auth_metadata: provider.auth_metadata,
          connected: provider.connected,
          model_count: provider.model_count,
          enabled_model_count: provider.enabled_model_count,
          last_sync: provider.last_sync,
          status_message: provider.status_message,
        }),
      updateProvider: (providerId, patch) =>
        updatePlatformProvider(data.me.id, providerId, patch),
      createProviderKey: (payload) => createProviderKey(data.me.id, payload),
      syncProviderModels: (providerId) =>
        syncProviderModels(data.me.id, providerId),
      updateModel: (modelId, patch) =>
        updatePlatformModel(
          data.me.id,
          modelId,
          modelPatchToUpdateRequest(patch),
        ),
      revealProviderKey: (keyId) => revealProviderKey(data.me.id, keyId),
      rotateProviderKey: (keyId) => rotateProviderKey(data.me.id, keyId),
      deleteProviderKey: (keyId) => deleteProviderKey(data.me.id, keyId),
      deleteProvider: (providerId, confirm) => deletePlatformProvider(data.me.id, providerId, confirm),
      // Connectors are owner-managed. The switch writes the catalog flags the
      // API enforces (chat, tools, bootstrap all read platform_enabled AND
      // tenant_enabled) and keeps the tenant credential record, when one
      // exists, in step so the displayed state cannot drift from the server.
      setConnectorEnabled: async (connector, enabled) => {
        const saved = await updatePlatformConnector(data.me.id, connector.id, {
          platform_enabled: enabled,
          tenant_enabled: enabled,
        });
        const patch: Partial<Connector> = {
          platform_enabled: saved.platform_enabled,
          tenant_enabled: saved.tenant_enabled,
        };
        try {
          if (connector.tenant_config_id) {
            const record = await updateAdminConnectorConfig(data.me.id, connector.tenant_config_id, {
              enabled,
              settings: { last_sync: enabled ? "Saved now" : "Disabled now" },
            });
            return { ...mapConnectorConfigRecordToConnector(record, { ...connector, ...patch }), ...patch };
          }
          if (enabled && connectorUsesCredentialRecord(connector.id)) {
            // Credential connectors need a tenant record to hold "on, awaiting
            // credentials"; without one the bootstrap mapping reads them as off.
            const record = await createAdminConnectorConfig(data.me.id, {
              connector_id: connector.id,
              tenant_id: data.currentTenant.id,
              enabled: true,
              auth_type: "oauth",
              scopes: connector.scopes,
              settings: { description: connector.description, last_sync: "Saved now" },
            });
            return { ...mapConnectorConfigRecordToConnector(record, { ...connector, ...patch }), ...patch };
          }
          return patch;
        } catch (error) {
          // The catalog write already committed. Show the persisted state
          // even when saving its credential record fails; retry can repair it.
          let persisted: Partial<Connector> = patch;
          try {
            const refreshed = await loadBootstrap(data.me.id);
            persisted = refreshed.connectors.find((item) => item.id === connector.id) ?? patch;
          } catch {
            // Preserve the fields confirmed by the first response, and leave
            // credentials unchanged until the user can retry or reload.
          }
          throw new ConnectorUpdateError(
            `${connector.name} availability was saved, but its credential settings could not be synchronized. ${error instanceof Error ? error.message : "Retry the change to finish saving."}`,
            persisted,
          );
        }
      },
      saveConnectorConfig: async (connector, payload) => {
        const record = connector.tenant_config_id
          ? await updateAdminConnectorConfig(data.me.id, connector.tenant_config_id, payload)
          : await createAdminConnectorConfig(data.me.id, {
              connector_id: connector.id,
              tenant_id: data.currentTenant.id,
              enabled: payload.enabled ?? connector.tenant_enabled,
              auth_type: payload.auth_type ?? undefined,
              settings: payload.settings ?? undefined,
              secret_value: payload.secret_value ?? undefined,
              service_password: payload.service_password ?? undefined,
            });
        return {
          connector: mapConnectorConfigRecordToConnector(record, connector),
          record,
        };
      },
      testConnectorConfig: (configId) => testAdminConnectorConfig(data.me.id, configId),
      connectorOAuthUrl: async (configId) => {
        const result = await connectorOAuthStartUrl(data.me.id, configId);
        return result.url;
      },
      createUser: (payload) => createAdminUser(data.me.id, payload),
      updateUser: (userId, patch) => updateAdminUser(data.me.id, userId, patch),
      deactivateUser: async (userId) => {
        await deactivateAdminUser(data.me.id, userId);
      },
      deleteUser: async (userId) => {
        await deleteAdminUser(data.me.id, userId);
      },
      resetUserPassword: async (userId, payload) => {
        await resetAdminUserPassword(data.me.id, userId, payload);
      },
      listAuditEvents: () => listPlatformAuditEvents(data.me.id),
      listPromptActivity: (targetUserId) =>
        listPlatformPromptActivity(data.me.id, { targetUserId, limit: 150 }),
      // Fetches one thread's full conversation for the audit preview; 500 is
      // the server-side maximum page size.
      listThreadPromptActivity: (threadId) =>
        listPlatformPromptActivity(data.me.id, { threadId, limit: 500 }),
      // Retention governance rides the admin endpoints, which already admit
      // platform owners and scope them to the deployment's sole tenant.
      listChatFeedback: () => listAdminChatFeedback(data.me.id, { limit: 500 }),
      listIssueReports: () => listAdminIssueReports(data.me.id, { limit: 500 }),
      loadIssueReportScreenshot: (reportId) =>
        getAdminIssueReportScreenshot(data.me.id, reportId),
      getRetentionPolicy: () => getAdminRetentionPolicy(data.me.id),
      updateRetentionPolicy: (patch) => updateAdminRetentionPolicy(data.me.id, patch),
      listRetentionThreads: () => listAdminRetentionThreads(data.me.id, { limit: 500 }),
      runRetentionBatch: (payload) => runAdminRetentionBatch(data.me.id, payload),
      listSecurityAlerts: (targetUserId) =>
        listPlatformSecurityAlerts(data.me.id, {
          targetUserId,
          includeAcknowledged: true,
          limit: 150,
        }),
      acknowledgeSecurityAlert: (alertId, acknowledged) =>
        updatePlatformSecurityAlert(data.me.id, alertId, { acknowledged }),
      getUsageSummary: (options) => getPlatformUsageSummary(data.me.id, options),
      listUsageRecords: (targetUserId) =>
        listPlatformUsageRecords(data.me.id, { targetUserId, limit: 500 }),
      listAlertRules: () => listPlatformAlertRules(data.me.id),
      createAlertRule: (payload) => createPlatformAlertRule(data.me.id, payload),
      updateAlertRule: (ruleId, patch) => updatePlatformAlertRule(data.me.id, ruleId, patch),
      deleteAlertRule: (ruleId) => deletePlatformAlertRule(data.me.id, ruleId),
      listAlertNotifications: () => listPlatformAlertNotifications(data.me.id, { limit: 200 }),
      setAlertNotificationArchived: (notificationId, archived) =>
        setPlatformAlertNotificationArchived(data.me.id, notificationId, archived),
      getEmailSettings: () => getPlatformEmailSettings(data.me.id),
      updateEmailSettings: (patch) => updatePlatformEmailSettings(data.me.id, patch),
      sendEmailTest: (recipient) => sendPlatformEmailTest(data.me.id, { recipient }),
      updateSsoConfig: async (configId, patch) => {
        const record = await updateAdminSsoConfig(data.me.id, configId, patch);
        return mapSsoConfigRecordToDisplay(record);
      },
      createSsoConfig: async (payload) => {
        const record = await createAdminSsoConfig(data.me.id, payload);
        return mapSsoConfigRecordToDisplay(record);
      },
      testSsoConfig: (configId) => testAdminSsoConfig(data.me.id, configId),
      getPlatformSettings: () => getPlatformSettings(data.me.id),
      updatePlatformSettings: (patch) => updatePlatformSettings(data.me.id, patch),
      updateTenantBranding: (tenantId, patch) =>
        updatePlatformTenantBranding(data.me.id, tenantId, patch),
      getElasticStatus: () => getPlatformElasticStatus(data.me.id),
    }),
    [data.me.id],
  );

  const chatBrandName =
    effectiveData.currentTenant.chat_brand_name?.trim() || "Aperture Chat";
  const chatBrandLogoUrl =
    effectiveData.currentTenant.icon_url?.trim() ||
    effectiveData.currentTenant.logo_url?.trim() ||
    null;
  const authBranding = !sessionUserId ? authOptions?.tenant_branding : null;
  const authBrandName =
    authBranding?.chat_brand_name?.trim() ||
    authBranding?.name?.trim() ||
    chatBrandName;
  const authBrandLogoUrl =
    authBranding?.icon_url?.trim() ||
    authBranding?.logo_url?.trim() ||
    chatBrandLogoUrl;

  useEffect(() => {
    if (sessionUserId || !authBranding) return;
    document.title = authBrandName;

    let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.rel = "icon";
      document.head.appendChild(favicon);
    }
    const faviconHref = authBrandLogoUrl || DEFAULT_FAVICON_HREF;
    favicon.href = faviconHref;
    favicon.type = faviconHref.endsWith(".svg") ? "image/svg+xml" : "";

    const themeColor = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (themeColor && authBranding.primary_color) {
      themeColor.content = authBranding.primary_color;
    }

    const appTitle = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );
    if (appTitle) {
      appTitle.content = authBrandName;
    }

    applyBrandTheme(authBranding);
    cacheBrandBoot({
      name: authBrandName,
      favicon: faviconHref,
      primary_color: authBranding.primary_color,
      gradient_start: authBranding.gradient_start,
      gradient_end: authBranding.gradient_end,
      text_color: authBranding.text_color,
    });
  }, [authBrandName, authBrandLogoUrl, authBranding, sessionUserId]);

  const content = useMemo(() => {
    if (view === "chat") {
      return (
        <ChatWorkspace
          data={effectiveData}
          chat={chat}
          brandName={chatBrandName}
          brandLogoUrl={chatBrandLogoUrl}
          requestedAgentId={requestedAgentId}
          onRequestedAgentConsumed={() => setRequestedAgentId(null)}
          onTransferToDraft={handleTransferToDraft}
        />
      );
    }
    if (view === "drafts") {
      return (
        <DocumentAssistantWorkspace
          key={draftSessionKey}
          data={effectiveData}
          brandName={chatBrandName}
          initialDraft={draftImport}
          initialServerDraftId={draftOpenServerId}
          actorUserId={effectiveData.me.id}
          onCloseDraft={() => setView("chat")}
          onNavigationGuardChange={registerDraftNavigationGuard}
        />
      );
    }
    if (view === "platform" && effectiveData.me.role === "PLATFORM_OWNER") {
      return (
        <PlatformConsole
          openDocumentationRequestKey={ownerDocumentationRequestKey}
          openProvidersRequestKey={platformSetupRequestKey}
          data={effectiveData}
          onDataChange={setData}
          platformActions={platformActions}
          onOpenAdminDocumentation={openAdminDocumentation}
          onOpenUserHelp={openHelpDrawer}
        />
      );
    }
    if (
      view === "admin" &&
      ["PLATFORM_OWNER", "TENANT_ADMIN"].includes(effectiveData.me.role)
    ) {
      return (
        <AdminConsole
          data={effectiveData}
          onDataChange={setData}
          adminApi={adminApi}
          openDocumentationRequestKey={adminDocumentationRequestKey}
        />
      );
    }
    if (view === "agents") {
      const agentTabs = (
        <SectionTabs
          ariaLabel="Agent workspace sections"
          tabs={[
            { key: "agents", label: "Agents" },
            { key: "automations", label: "Automations" },
          ]}
          active={agentsSection}
          onSelect={(key) => setAgentsSection(key as "agents" | "automations")}
        />
      );
      return (
        <div className="console-page agent-workspace-shell">
          <div className="console-section-controls">{agentTabs}</div>
          {agentsSection === "automations" ? (
          <AutomationsConsole
            data={effectiveData}
            actorUserId={data.me.id}
            onDataChange={setData}
          />
          ) : (
        <AgentWorkspaceConsole
          data={effectiveData}
          onDataChange={setData}
          onUseInChat={(modelId) => {
            chat.setModel(modelId);
            setRequestedAgentId(modelId);
            setView("chat");
          }}
        />
          )}
        </div>
      );
    }
    return (
      <LibraryConsole
        data={effectiveData}
        view={libraryTab}
        onDataChange={setData}
        sectionTabs={
          <SectionTabs
            ariaLabel="Library sections"
            tabs={[
              { key: "knowledge", label: "Knowledge" },
              { key: "tools", label: "Tools" },
            ]}
            active={libraryTab}
            onSelect={(key) => setLibraryTab(key as "knowledge" | "tools")}
          />
        }
      />
    );
  }, [
    adminApi,
    agentsSection,
    effectiveData,
    libraryTab,
    platformActions,
    view,
    chat,
    chatBrandName,
    chatBrandLogoUrl,
    draftSessionKey,
    draftImport,
    draftOpenServerId,
    registerDraftNavigationGuard,
    handleTransferToDraft,
    openAdminDocumentation,
    openHelpDrawer,
    adminDocumentationRequestKey,
    ownerDocumentationRequestKey,
    platformSetupRequestKey,
    requestedAgentId,
    data.me.id,
  ]);

  if (!sessionUserId && pendingPasswordChange) {
    return (
      <ForcedPasswordScreen
        displayName={pendingPasswordChange.result.user.display_name}
        onSubmit={completeForcedPasswordChange}
        onCancel={cancelForcedPasswordChange}
      />
    );
  }

  if (!sessionUserId) {
    return (
      <AuthScreen
        authOptions={authOptions}
        tenantName={authBrandName}
        tenantLogoUrl={authBrandLogoUrl}
        isLoading={authLoading && !authOptions}
        isSubmitting={authLoading && Boolean(authOptions)}
        error={authError ?? signOutNotice}
        onRetry={() => setAuthOptionsAttempt((attempt) => attempt + 1)}
        onSubmit={(payload) => void handleAuthLogin(payload)}
        onLocalLogin={(payload) => {
          if (payload) void handleAuthLogin(payload);
        }}
        onBootstrapOwner={(payload) => void handleBootstrapOwner(payload)}
      />
    );
  }

  if (!sessionHydrated) {
    /* A stored session exists but its real bootstrap data has not arrived, so
     * `data` still holds the bundled sample workspace. Rendering the shell now
     * would flash its placeholder account ("Alex Morgan") in place of the real
     * signed-in identity, so hold on a neutral branded screen instead. */
    if (!bootstrapError) {
      return <SessionRestoreScreen />;
    }
    if (!demoFallbackEnabled()) {
      return (
        <SessionRestoreScreen
          error={bootstrapError}
          onRetry={() => {
            setBootstrapError(null);
            setBootstrapAttempt((attempt) => attempt + 1);
          }}
          onSignOut={handleSignOut}
        />
      );
    }
    /* Dev and demo builds fall through to the sample-data preview; the
     * offline banner below labels it honestly as a local preview. */
  }

  return (
    <AppShell
      data={effectiveData}
      actualRole={data.me.role}
      viewAsRole={viewAsRole}
      onViewAsRoleChange={setViewAsRole}
      currentView={view}
      onViewChange={handleViewChange}
      openHelpRequestKey={helpDrawerRequestKey}
      darkMode={darkMode}
      onToggleDarkMode={handleToggleDarkMode}
      pwaInstallTarget={mobileInstallTarget}
      onOpenPwaInstall={openPwaInstallPrompt}
      threads={chat.threads}
      activeChatId={chat.activeId}
      onOpenChat={openChat}
      onNewChat={startNewChat}
      onOpenDraft={handleOpenDraftFromSearch}
      onTogglePin={chat.togglePin}
      onArchiveThread={chat.archiveThread}
      onRestoreThread={chat.restoreThread}
      onDeleteThread={chat.deleteThread}
      onMoveThreadToFolder={chat.moveThreadToFolder}
      onSignOut={handleSignOut}
      onRequestSignOut={requestSignOut}
      onProfileUpdate={handleAccountProfileUpdate}
      onPasswordUpdate={handleAccountPasswordUpdate}
      onApiKeyLoad={handleAccountApiKeyLoad}
      onApiKeyCreate={handleAccountApiKeyCreate}
      onApiKeyRevoke={handleAccountApiKeyRevoke}
      onSubmitIssueReport={async (payload) => {
        await submitIssueReport(data.me.id, payload);
      }}
      memoryApi={memoryApi}
    >
      {loading && (
        <div className="sr-status">Syncing {chatBrandName} controls...</div>
      )}
      {bootstrapError && (
        <div className="offline-banner" role="status">
          {bootstrapError} Local configuration preview is visible; changes made
          here are session-only.
        </div>
      )}
      {appNotice && (
        <div className={`app-notice app-notice-${appNotice.tone}`} role="status">
          <span>{appNotice.message}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            data-tooltip="Hide this notification message from the screen"
            onClick={() => setAppNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      {pwaInstallPlatform && (
        <PwaInstallPrompt
          platform={pwaInstallPlatform}
          brandName={chatBrandName}
          brandLogoUrl={chatBrandLogoUrl}
          onDismiss={dismissPwaInstallPrompt}
        />
      )}
      {sessionHydrated && !viewAsRole && firstRunGuideRequest?.userId === data.me.id && !data.me.first_run_guide_seen_at && (
        <FirstRunWelcome
          data={data}
          onDismiss={acknowledgeFirstRun}
          onNavigate={(next) => {
            acknowledgeFirstRun();
            if (next === "platform") setPlatformSetupRequestKey((key) => key + 1);
            handleViewChange(next);
          }}
          onGuide={() => {
            acknowledgeFirstRun();
            if (data.me.role === "PLATFORM_OWNER") {
              handleViewChange("platform");
              setOwnerDocumentationRequestKey((key) => key + 1);
            } else if (data.me.role === "TENANT_ADMIN") {
              handleViewChange("admin");
              setAdminDocumentationRequestKey((key) => key + 1);
            } else {
              setHelpDrawerRequestKey((key) => key + 1);
            }
          }}
        />
      )}
      {content}
    </AppShell>
  );
}

/** Segmented switch shown in a console header when one rail destination
 * hosts multiple sections (Library: Knowledge/Tools; Agents: Agents/Automations). */
function SectionTabs({
  tabs,
  active,
  onSelect,
  ariaLabel,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
  ariaLabel: string;
}) {
  const dragStart = useRef<number | null>(null);
  const suppressClick = useRef(false);
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.key === active));
  return (
    <div className="section-switch" role="group" aria-label={ariaLabel}
      data-active-index={activeIndex}
      onPointerDown={event => {
        if (event.button !== 0) return;
        dragStart.current = event.clientX;
        suppressClick.current = false;
        // Capture on the pressed button so a normal click keeps its target,
        // while a drag can finish beyond the edge of the track.
        const button = event.target instanceof Element ? event.target.closest("button") : null;
        button?.setPointerCapture?.(event.pointerId);
      }}
      onPointerUp={event => {
        const start = dragStart.current;
        dragStart.current = null;
        if (start !== null && Math.abs(event.clientX - start) > 24) {
          suppressClick.current = true;
          onSelect(tabs[event.clientX > start ? tabs.length - 1 : 0].key);
        }
      }}
      onPointerCancel={() => { dragStart.current = null; }}
      onKeyDown={event => {
        const index = event.key === "ArrowRight" || event.key === "End" ? tabs.length - 1
          : event.key === "ArrowLeft" || event.key === "Home" ? 0 : null;
        if (index === null) return;
        event.preventDefault();
        onSelect(tabs[index].key);
        event.currentTarget.querySelectorAll("button")[index]?.focus();
      }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          aria-pressed={active === tab.key}
          className={`section-switch-tab${active === tab.key ? " is-active" : ""}`}
          data-tooltip={`Switch to the ${tab.label} section`}
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            onSelect(tab.key);
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function previewRolesFor(role: Role): Role[] {
  if (role === "PLATFORM_OWNER")
    return ["PLATFORM_OWNER", "TENANT_ADMIN", "USER"];
  if (role === "TENANT_ADMIN") return ["TENANT_ADMIN", "USER"];
  return [role];
}

function resolveViewForRole(view: ViewKey, role: Role): ViewKey {
  if (view === "platform" && role !== "PLATFORM_OWNER") {
    return role === "TENANT_ADMIN" ? "admin" : "chat";
  }
  if (
    view === "admin" &&
    role !== "PLATFORM_OWNER" &&
    role !== "TENANT_ADMIN"
  ) {
    return "chat";
  }
  return view;
}

function transferredDraftTitle(threadTitle: string, content: string) {
  const plainText = markdownToPlainText(content);
  const firstLine = plainText
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean);
  const base =
    threadTitle && threadTitle !== "New chat"
      ? threadTitle
      : firstLine ?? "Transferred Chat Draft";
  const cleaned = base.replace(/\s+/g, " ").trim() || "Transferred Chat Draft";
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function dataForRolePreview(data: BootstrapData, role: Role): BootstrapData {
  if (role === data.me.role) return data;

  // Platform owners hold no tenant group memberships, so previewing a tenant
  // role simulates a fully granted tenant member: grant-based model, knowledge,
  // and tool access stays visible instead of collapsing to an ungranted account.
  const previewGroupIds =
    data.me.group_ids.length > 0
      ? data.me.group_ids
      : data.groups.map((group) => group.id);

  return {
    ...data,
    me: { ...data.me, role, group_ids: previewGroupIds },
    // Tenant-scoped user lists never include platform owners (see README).
    visibleUsers:
      role === "TENANT_ADMIN" || role === "PLATFORM_OWNER"
        ? data.users.filter((user) => user.role !== "PLATFORM_OWNER")
        : [],
    providerKeys: role === "PLATFORM_OWNER" ? data.providerKeys : [],
  };
}

function replaceBootstrapUser(data: BootstrapData, updatedUser: User): BootstrapData {
  const replaceUser = (user: User) => (user.id === updatedUser.id ? updatedUser : user);
  return {
    ...data,
    me: data.me.id === updatedUser.id ? updatedUser : data.me,
    users: data.users.map(replaceUser),
    visibleUsers: data.visibleUsers.map(replaceUser),
  };
}

function readInitialSessionUserId() {
  try {
    // An SSO redirect return (#sso_session=...) owns session setup; skip restores.
    if (window.location.hash.startsWith("#sso_")) return null;
    const params = new URLSearchParams(window.location.search);
    const persona = params.get("persona");
    if (persona) return resolvePersonaAlias(persona);
    const savedPersona = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return savedPersona ? resolvePersonaAlias(savedPersona) : null;
  } catch {
    return null;
  }
}

/** Read and consume the ?connector_oauth=success|error query left by the Google Drive OAuth callback. */
function consumeConnectorOAuthReturn(): { success: boolean; message: string } | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("connector_oauth");
    if (!outcome) return null;
    const message = params.get("message") ?? "";
    params.delete("connector_oauth");
    params.delete("message");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
    return {
      success: outcome === "success",
      message:
        outcome === "success"
          ? "Google Drive is connected. A refresh token is stored server-side; run Test connection on the connector to verify access."
          : message || "The Google Drive OAuth flow did not complete.",
    };
  } catch {
    return null;
  }
}

/** Read and consume the #sso_session / #sso_error / #sso_mfa fragment left by
 * the OIDC callback. The fragment is stripped from the URL immediately so the
 * session token or pre-session MFA challenge token never lingers in history. */
function consumeSsoReturnFragment(): { token?: string; error?: string; mfaChallengeToken?: string } | null {
  try {
    const hash = window.location.hash;
    if (!hash.startsWith("#sso_")) return null;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get("sso_session") ?? undefined;
    const error = params.get("sso_error") ?? undefined;
    const mfaChallengeToken = params.get("sso_mfa") ?? undefined;
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    if (!token && !error && !mfaChallengeToken) return null;
    return { token, error, mfaChallengeToken };
  } catch {
    return null;
  }
}

function resolvePersonaAlias(persona: string) {
  return PERSONA_ALIASES[persona] ?? persona;
}

function persistSessionUserId(userId: string) {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, userId);
  } catch {
    // Session persistence is a convenience; the active React session still owns access.
  }
}

function clearSessionUserId() {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign out.
  }
}

function readBooleanPreference(storageKey: string, fallback: boolean) {
  try {
    const savedValue = window.localStorage.getItem(storageKey);
    if (savedValue === "true") return true;
    if (savedValue === "false") return false;
  } catch {
    // Keep the default when localStorage is unavailable.
  }
  return fallback;
}

function persistBooleanPreference(storageKey: string, value: boolean) {
  try {
    window.localStorage.setItem(storageKey, value ? "true" : "false");
  } catch {
    // Theme persistence is a convenience layer; the active React state still updates.
  }
}

function clearPersonaQueryParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("persona")) return;
    url.searchParams.delete("persona");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Session recovery can still continue without URL mutation.
  }
}

function isInactiveSessionError(error: unknown) {
  return error instanceof ChatRequestError && error.status === 401;
}

function modelPatchToUpdateRequest(
  patch: Partial<ModelConfig>,
): PlatformModelUpdateRequest {
  return {
    provider_id: patch.provider_id,
    name: patch.name,
    upstream_model_id: patch.upstream_model_id,
    system_prompt: patch.system_prompt,
    meta_prompt: patch.meta_prompt ?? patch.system_prompt,
    knowledge_config_ids:
      patch.knowledge_base_ids ?? patch.knowledge_config_ids,
    tool_config_ids: patch.tool_ids ?? patch.tool_config_ids,
    platform_enabled: patch.platform_enabled,
    tenant_restricted: patch.tenant_restricted,
    group_ids: patch.group_ids,
    notes: patch.notes,
    is_custom: patch.is_custom,
    created_by: patch.created_by,
    context_window: patch.context_window,
    visibility: patch.visibility,
    agentic_companion: patch.agentic_companion,
    prompt_template_ids: patch.prompt_template_ids,
    skill_file_ids: patch.skill_file_ids,
  };
}
