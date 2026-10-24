/** What Mate asks of an AI, in two rows. Open until a provider is set up. */
export default function NeedsExplainer({ open }: { open: boolean }) {
  return (
    <details className="ai-needs" open={open}>
      <summary>What does Mate need from an AI?</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            <th scope="col">Needs</th>
            <th scope="col">If the model cannot do it</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Checking handwritten maths (the tutor)</th>
            <td>Image input ("vision") and a JSON answer</td>
            <td>The tutor is off; everything else works</td>
          </tr>
          <tr>
            <th scope="row">Ask about a line, summaries, titles, practice questions</th>
            <td>Text input and output</td>
            <td>-</td>
          </tr>
        </tbody>
      </table>
    </details>
  );
}
