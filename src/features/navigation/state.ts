/** UI-only state owned by the navigation feature (Dev A may change freely). */
import { create } from 'zustand';

interface NavUiState {
  /** Member panel visibility (default open; hidden for DMs regardless). */
  membersOpen: boolean;
  toggleMembers(): void;
  setMembersOpen(open: boolean): void;
  /** Collapsed sidebar sections, keyed by section id ("text-channels", "direct-messages", ...). */
  collapsed: Record<string, boolean>;
  toggleSection(id: string): void;
}

export const useNavUiStore = create<NavUiState>((set) => ({
  membersOpen: true,
  toggleMembers: () => set((s) => ({ membersOpen: !s.membersOpen })),
  setMembersOpen: (open) => set({ membersOpen: open }),
  collapsed: {},
  toggleSection: (id) => set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
}));
