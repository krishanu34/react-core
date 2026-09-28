/**
 * DevSphereShell — navigation regression guard.
 *
 * The shell previously rendered only a brand bar, so /workspaces/guide and
 * /workspaces/setup had no link anywhere in the app: a user whose daemon was
 * already connected could never get back to Daemon Setup to stop, update or
 * uninstall it. These tests assert those routes stay linked, that Workspaces
 * stays gated on the daemon, and that immersive routes still render bare.
 */

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/workspaces";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

let daemonConnected = false;
vi.mock("@/lib/hooks/useDaemonStatus", () => ({
  useDaemonStatus: () => ({
    connected: daemonConnected,
    version: daemonConnected ? "1.4.2" : null,
    checking: false,
    installed: daemonConnected,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/lib/auth", () => ({
  getUser: () => ({
    user_id: 1,
    username: "ada",
    role: "admin",
    roles: [],
    is_admin: true,
  }),
  logout: vi.fn(),
}));

vi.mock("@/providers/ProjectProvider", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DevSphereShell } from "@/components/shell/DevSphereShell";

/**
 * Look inside the sidebar <nav> only: "Workspaces" is also the top-bar page
 * title, so an unscoped query matches two nodes.
 */
function navItem(label: string): HTMLElement {
  return within(screen.getByRole("navigation")).getByText(label);
}

function hrefOf(label: string): string | null {
  return navItem(label).closest("a")?.getAttribute("href") ?? null;
}

beforeEach(() => {
  pathname = "/workspaces";
  daemonConnected = false;
});

describe("DevSphereShell navigation", () => {
  it("links to Setup Guide and Daemon Setup even when the daemon is down", () => {
    render(<DevSphereShell><p>content</p></DevSphereShell>);

    expect(hrefOf("Setup Guide")).toBe("/workspaces/guide");
    expect(hrefOf("Daemon Setup")).toBe("/workspaces/setup");
  });

  it("keeps Daemon Setup reachable once the daemon IS connected", () => {
    daemonConnected = true;
    pathname = "/workspaces";
    render(<DevSphereShell><p>content</p></DevSphereShell>);

    // The regression: with a connected daemon there was no route back here,
    // so Stop / Update / Uninstall were unreachable.
    expect(hrefOf("Daemon Setup")).toBe("/workspaces/setup");
  });

  it("gates Workspaces on the daemon, then enables it", () => {
    const { unmount } = render(<DevSphereShell><p>content</p></DevSphereShell>);
    // Disabled items render as a span, not a link.
    expect(navItem("Workspaces").closest("a")).toBeNull();
    unmount();

    daemonConnected = true;
    render(<DevSphereShell><p>content</p></DevSphereShell>);
    expect(hrefOf("Workspaces")).toBe("/workspaces");
  });

  it("renders immersive routes bare — no sidebar in the IDE or on login", () => {
    pathname = "/workspaces/42/ide";
    const { unmount } = render(<DevSphereShell><p>ide</p></DevSphereShell>);
    expect(screen.queryByText("Daemon Setup")).toBeNull();
    expect(screen.getByText("ide")).toBeInTheDocument();
    unmount();

    pathname = "/login";
    render(<DevSphereShell><p>login</p></DevSphereShell>);
    expect(screen.queryByText("Daemon Setup")).toBeNull();
    expect(screen.getByText("login")).toBeInTheDocument();
  });
});
