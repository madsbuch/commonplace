/** The writing assistant beside a page (filled in by the AI work). */
export function AssistantPanel(props: { pageId: string; onClose: () => void }) {
  return (
    <aside className="assistant">
      <button type="button" onClick={props.onClose}>
        Close
      </button>
      <p>Assistant for {props.pageId}</p>
    </aside>
  );
}
