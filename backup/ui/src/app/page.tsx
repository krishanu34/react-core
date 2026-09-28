import { redirect } from "next/navigation";

/** DevSphere is workspace-first: the home route sends you straight to Workspaces. */
export default function Home() {
  redirect("/workspaces");
}
