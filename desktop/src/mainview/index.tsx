import { createRoot } from "react-dom/client";

function LoadingScreen() {
  return (
    <div className="loading-container">
      <div className="loading-text">Starting Zero Agent</div>
      <div>
        <span className="loading-dot" />
        <span className="loading-dot" />
        <span className="loading-dot" />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<LoadingScreen />);
