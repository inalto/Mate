import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage as message } from "../../../i18n";
import {
  nextcloudLoginPoll,
  nextcloudLoginStart,
  nextcloudLogout,
  nextcloudStatus,
  type NextcloudStatus,
} from "../../../ipc/share";
import { Row, SettingsSection } from "../rows";

export const POLL_MS = 2000;

export default function SharingSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<NextcloudStatus | null>(null);
  const [server, setServer] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);

  const stopPolling = useCallback(() => {
    attempt.current += 1; // invalidates any poll in flight
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const refresh = useCallback(
    () =>
      nextcloudStatus().then(
        setStatus,
        () => setStatus({ signedIn: false, server: "", user: "" }),
      ),
    [],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the saved sign-in from the backend
    void refresh();
    return stopPolling;
  }, [refresh, stopPolling]);

  const signIn = async () => {
    setError(null);
    stopPolling();
    const id = attempt.current;
    try {
      await nextcloudLoginStart(server.trim());
    } catch (err) {
      setError(message(err));
      return;
    }
    setWaiting(true);
    const tick = async () => {
      try {
        const { done } = await nextcloudLoginPoll();
        if (attempt.current !== id) return;
        if (done) {
          setWaiting(false);
          await refresh();
          return;
        }
      } catch (err) {
        if (attempt.current !== id) return;
        setWaiting(false);
        setError(message(err));
        return;
      }
      timer.current = setTimeout(() => void tick(), POLL_MS);
    };
    timer.current = setTimeout(() => void tick(), POLL_MS);
  };

  const cancel = () => {
    stopPolling();
    setWaiting(false);
  };

  const signOut = async () => {
    setError(null);
    try {
      await nextcloudLogout();
      await refresh();
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <SettingsSection id="sharing" title={t("settings.nav.sections.sharing")}>
      <Row id="sharing-nextcloud" label={t("settings.sharing.nextcloud.label")} hint={t("settings.sharing.nextcloud.hint")}>
        {status?.signedIn ? (
          <>
            <span>{t("settings.sharing.nextcloud.signedIn", { user: status.user, server: status.server })}</span>
            <button type="button" className="btn" onClick={() => void signOut()}>
              {t("settings.sharing.nextcloud.signOut")}
            </button>
          </>
        ) : waiting ? (
          <>
            <span role="status">{t("settings.sharing.nextcloud.waiting")}</span>
            <button type="button" className="btn" onClick={cancel}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <input
              className="input"
              type="url"
              aria-label={t("settings.sharing.nextcloud.server")}
              placeholder="https://cloud.example.com"
              value={server}
              onChange={(e) => setServer(e.target.value)}
            />
            <button type="button" className="btn" disabled={!server.trim()} onClick={() => void signIn()}>
              {t("settings.sharing.nextcloud.signIn")}
            </button>
          </>
        )}
      </Row>
      <p className="form-error" role="alert" hidden={!error}>
        {error}
      </p>
    </SettingsSection>
  );
}
