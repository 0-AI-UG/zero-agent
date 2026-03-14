import { createContext, useContext, type ReactNode } from "react";

const FilePreviewActionsContext = createContext<{
  setActions: (actions: ReactNode) => void;
}>({ setActions: () => {} });

export const usePreviewActions = () => useContext(FilePreviewActionsContext);
export const PreviewActionsProvider = FilePreviewActionsContext.Provider;
