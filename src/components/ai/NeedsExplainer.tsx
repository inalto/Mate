import { Check, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { AiIcon } from "./AiField";

/** What Mate asks of an AI, in two rows. Open until a provider is set up. */
export default function NeedsExplainer({ open }: { open: boolean }) {
  const { t } = useTranslation();
  return (
    <details className="ai-needs" open={open}>
      <summary>{t("ai.needs.title")}</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("ai.needs.feature")}</th>
            <th scope="col">{t("ai.needs.needs")}</th>
            <th scope="col">{t("ai.needs.fallback")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{t("ai.needs.tutor")}</th>
            <td>
              <AiIcon icon={Check} />
              {t("ai.needs.tutorNeeds")}
            </td>
            <td>
              <AiIcon icon={X} />
              {t("ai.needs.tutorFallback")}
            </td>
          </tr>
          <tr>
            <th scope="row">{t("ai.needs.text")}</th>
            <td>
              <AiIcon icon={Check} />
              {t("ai.needs.textNeeds")}
            </td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}
