import { useTranslation } from "react-i18next";

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
            <td>{t("ai.needs.tutorNeeds")}</td>
            <td>{t("ai.needs.tutorFallback")}</td>
          </tr>
          <tr>
            <th scope="row">{t("ai.needs.text")}</th>
            <td>{t("ai.needs.textNeeds")}</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}
