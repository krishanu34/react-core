import { Header } from "@/components/Header";
import { Workspace } from "@/components/Workspace";

export default function Home() {
  return (
    <div className="flex h-screen flex-col bg-bell-chrome">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col">
        <Workspace />
      </main>
    </div>
  );
}
