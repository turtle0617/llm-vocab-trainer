import { initializeApp, type FirebaseApp } from "firebase/app";
import { getToken, initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from "firebase/app-check";
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth
} from "firebase/auth";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "requiresLogin";
type AuthListener = (status: AuthStatus) => void;

const useMockAuth = import.meta.env.DEV && !import.meta.env.VITE_API_BASE_URL;
const listeners = new Set<AuthListener>();
let status: AuthStatus = useMockAuth ? "authenticated" : "loading";
let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let appCheck: AppCheck | null = null;
let emulatorConnected = false;

export async function signIn(email: string, password: string) {
  if (useMockAuth) {
    setStatus("authenticated");
    return;
  }
  await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  setStatus("authenticated");
}

export async function signOut() {
  if (useMockAuth) {
    setStatus("anonymous");
    return;
  }
  await firebaseSignOut(getFirebaseAuth());
  setStatus("anonymous");
}

export async function getIdToken(options: { forceRefresh?: boolean } = {}) {
  if (useMockAuth) return null;
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken(options.forceRefresh ?? false);
}

export async function getAppCheckToken(options: { forceRefresh?: boolean } = {}) {
  if (useMockAuth) return null;
  return (await getToken(getFirebaseAppCheck(), options.forceRefresh ?? false)).token;
}

export function getCurrentUserUid() {
  if (useMockAuth) return "mock-user";
  return getFirebaseAuth().currentUser?.uid ?? null;
}

export function subscribeAuthState(callback: AuthListener) {
  listeners.add(callback);
  callback(status);

  if (!useMockAuth) {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), (user) => {
      setStatus(user ? "authenticated" : "anonymous");
    });
    return () => {
      listeners.delete(callback);
      unsubscribe();
    };
  }

  return () => {
    listeners.delete(callback);
  };
}

export function getAuthStatus() {
  return status;
}

export function markRequiresLogin() {
  setStatus("requiresLogin");
}

function setStatus(next: AuthStatus) {
  status = next;
  listeners.forEach((listener) => listener(status));
}

function getFirebaseAuth() {
  const firebaseApp = getFirebaseApp();

  if (!auth) {
    auth = getAuth(firebaseApp);
  }

  if (import.meta.env.VITE_USE_AUTH_EMULATOR === "true" && !emulatorConnected) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    emulatorConnected = true;
  }

  return auth;
}

function getFirebaseApp() {
  if (!app) {
    app = initializeApp({
      apiKey: requireEnv("VITE_FIREBASE_API_KEY"),
      authDomain: requireEnv("VITE_FIREBASE_AUTH_DOMAIN"),
      appId: requireEnv("VITE_FIREBASE_APP_ID"),
      projectId: requireEnv("VITE_FIREBASE_PROJECT_ID")
    });
  }

  if (!app) throw new Error("Firebase app failed to initialize.");
  return app;
}

function getFirebaseAppCheck() {
  if (!appCheck) {
    const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
    if (import.meta.env.DEV && debugToken) {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === "true" ? true : debugToken;
    }

    appCheck = initializeAppCheck(getFirebaseApp(), {
      provider: new ReCaptchaV3Provider(requireEnv("VITE_RECAPTCHA_SITE_KEY")),
      isTokenAutoRefreshEnabled: true
    });
  }

  return appCheck;
}

function requireEnv(
  name:
    | "VITE_FIREBASE_API_KEY"
    | "VITE_FIREBASE_AUTH_DOMAIN"
    | "VITE_FIREBASE_APP_ID"
    | "VITE_FIREBASE_PROJECT_ID"
    | "VITE_RECAPTCHA_SITE_KEY"
) {
  const value = import.meta.env[name];
  if (!value) throw new Error(`${name} is required when using the live API.`);
  return value;
}

declare global {
  interface Window {
    FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
  }
}
