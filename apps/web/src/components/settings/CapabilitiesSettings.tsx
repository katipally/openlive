"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { useLiveStore } from "@/lib/live/liveStore";
import { toolCount } from "@/lib/capabilities";
import { Segmented } from "@/components/ui";
import { ConnectorsSettings, connectorsQuery } from "./ConnectorsSettings";
import { SkillsSettings, skillsQuery } from "./SkillsSettings";
import { ToolsSettings, capabilitiesQuery } from "./ToolsSettings";

const PANES = { tools: ToolsSettings, skills: SkillsSettings, connectors: ConnectorsSettings };

/** What every brain can use: OpenLive's own tools, skills and connectors, one
 *  subtab each. The counts share each subtab's own query. */
export function CapabilitiesSettings() {
  const tab = useUi((s) => s.capabilitiesTab);
  const setTab = useUi((s) => s.setCapabilitiesTab);
  const workspace = useLiveStore((s) => s.boundCwd);
  const tools = useQuery({ ...capabilitiesQuery, retry: 1 }).data;
  const skills = useQuery({ ...skillsQuery(workspace), retry: 1 }).data;
  const connectors = useQuery({ ...connectorsQuery, retry: 1 }).data;
  useEffect(() => featureUsed(`n_settings_tab_${tab}`), [tab]);
  const Pane = PANES[tab];

  return (
    <div className="flex flex-col gap-5">
      <Segmented label="Capabilities" anchor="set-capabilities" value={tab} onChange={setTab} className="w-full"
        options={[
          { id: "tools", label: "Tools", count: tools && toolCount(tools.groups) },
          { id: "skills", label: "Skills", count: skills?.skills.length },
          // The built-in web search is a connector row too.
          { id: "connectors", label: "Connectors", count: connectors && connectors.connectors.length + (tools?.groups.some((g) => g.id === "web") ? 1 : 0) },
        ]} />
      <Pane />
    </div>
  );
}
