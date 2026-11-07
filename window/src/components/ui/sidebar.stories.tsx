import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FolderKanban, Home, Inbox, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

const meta = {
  title: "UI/Sidebar",
  component: Sidebar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Sidebar>;

export default meta;

type Story = StoryObj<typeof meta>;

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenuButton size="lg">Fabric</SidebarMenuButton>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>
                    <Home />
                    Home
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    <Inbox />
                    Inbox
                  </SidebarMenuButton>
                  <SidebarMenuBadge>3</SidebarMenuBadge>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton>
                    <FolderKanban />
                    Projects
                  </SidebarMenuButton>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton size="sm" isActive>engram</SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton size="sm">relay</SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenuButton>
            <Settings />
            Settings
          </SidebarMenuButton>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
        <p>Main content</p>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * Collapse and expand: via the trigger and via the Ctrl+B shortcut —
 * `data-state` flips on the sidebar and the desktop container slides with it.
 */
export const CollapseExpand: Story = {
  name: "Collapse expand",
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Expanded first: the desktop container is in the layout.
    const sidebar = canvasElement.querySelector<HTMLElement>("[data-slot=sidebar]");
    expect(sidebar).not.toBeNull();
    expect(sidebar!.dataset.state).toBe("expanded");

    const trigger = canvas.getByRole("button", { name: "Toggle Sidebar" });

    // Click the trigger: state flips to collapsed...
    const user = userEvent.setup();
    await user.click(trigger);
    expect(sidebar!.dataset.state).toBe("collapsed");

    // ...and back again.
    await user.click(trigger);
    expect(sidebar!.dataset.state).toBe("expanded");

    // The keyboard shortcut (Ctrl+B) toggles too — no pointer needed.
    await user.keyboard("{Control>}b}");
    expect(sidebar!.dataset.state).toBe("collapsed");
    await user.keyboard("{Control>}b}");
    expect(sidebar!.dataset.state).toBe("expanded");
  },
};

/** Menu state: the active button is flagged, badges and sub-nav ride along. */
export const MenuStates: Story = {
  name: "Menu states",
  render: () => <Shell />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Active menu button: flagged in the DOM so data-active styles can bite.
    const active = canvas.getByRole("button", { name: "Home" });
    expect(active).toHaveAttribute("data-active", "true");
    expect(active.classList.contains("data-active:bg-sidebar-accent")).toBe(true);

    // Inactive ones are not flagged.
    expect(canvas.getByRole("button", { name: "Inbox" })).toHaveAttribute("data-active", "false");

    // The inbox badge is a sibling of its button, keyed off the menu item.
    const inboxItem = canvas.getByRole("button", { name: "Inbox" }).closest("[data-slot=sidebar-menu-item]");
    expect(inboxItem!.querySelector("[data-slot=sidebar-menu-badge]")!.textContent).toBe("3");

    // Sub navigation: the active sub-button is flagged, sizes are authored.
    // (An <a> without href has no link role, so it is found by text.)
    const sub = canvas.getByText("engram");
    expect(sub).toHaveAttribute("data-active", "true");
    expect(sub).toHaveAttribute("data-size", "sm");
  },
};
