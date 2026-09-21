import "./mini.css";
import type { ReactNode } from "react";
import { TelegramProvider } from "../../components/mini/telegram-webapp";

export default function MiniLayout({ children }: { children: ReactNode }) {
  return (
    <div id="mini-shell">
      <TelegramProvider>{children}</TelegramProvider>
    </div>
  );
}
