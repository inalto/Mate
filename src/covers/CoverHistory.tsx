// The last answers to one cover as up to five dots in the selection bar: filled for known, hollow
// for missed, oldest on the left. Nothing while loading, for a cover never asked, or when the
// history cannot be read.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { recallElementHistory } from "../ipc/recall";
import "./covers.css";

const LAST = 5;

export default function CoverHistory({ id }: { id: string }) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<{ id: string; answers: boolean[] } | null>(null);

  useEffect(() => {
    let live = true;
    recallElementHistory(id, LAST)
      .then((answers) => live && setHistory({ id, answers }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);

  // Another cover's answers are not shown while this one loads.
  const answers = history?.id === id ? history.answers : [];
  if (answers.length === 0) return null;
  const known = answers.filter(Boolean).length;
  return (
    <svg
      className="cover-history"
      role="img"
      width={answers.length * 10}
      height={10}
      aria-label={t("covers.history", { known, missed: answers.length - known })}
    >
      {answers.map((k, i) => (
        <circle key={i} data-known={k} cx={i * 10 + 5} cy={5} r={3.5} className={k ? "cover-dot known" : "cover-dot"} />
      ))}
    </svg>
  );
}
