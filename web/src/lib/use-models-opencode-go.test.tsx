import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@/components/model-selector";

const go: Model = {
  id: "opencode-go/kimi-k2.6", label: "Kimi K2.6", provider: "OpenCode Go",
  sourceId: "opencode-go", sourceLabel: "OpenCode Go", tier: "high",
  context_length: 262_144, pricing: { prompt: 0.95, completion: 4 },
  modality: "text+image->text", description: "OpenCode Go subscription",
  reasoning: true, billingMode: "subscription", available: true,
};
let configured: boolean;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.resetModules();
  configured = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/providers/models")) return json({ providers: [{ id: "opencode-go", configured }], models: configured ? [go] : [] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: false } });
    if (url.endsWith("/model-providers")) return json({ providers: [] });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    return json({ available: false, configured: false, models: [] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("selectable OpenCode Go", () => {
  it("discovers Go after saving a key and disconnects persisted selections after clearing it", async () => {
    const { useModels } = await import("./use-models");
    const { PROVIDER_AUTH_CHANGED_EVENT } = await import("./use-provider-auth");
    const { result } = renderHook(() => useModels());
    await waitFor(() => expect(result.current.modelAvailability(go)).toBe("unavailable"));
    configured = true;
    act(() => window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT)));
    await waitFor(() => expect(result.current.modelAvailability(go)).toBe("available"));
    expect(result.current.directProviderModels).toEqual([go]);
    expect(result.current.models.find((m) => m.id.startsWith("openrouter/"))?.available).toBe(false);
    configured = false;
    act(() => window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT)));
    await waitFor(() => expect(result.current.modelAvailability(go)).toBe("unavailable"));
    expect(result.current.directProviderModels).toEqual([]);
  });

  it("renders subscription limits and selects the current Go metadata", async () => {
    configured = true;
    const { ModelSelector } = await import("@/components/model-selector");
    const select = vi.fn();
    render(<ModelSelector selected={{ ...go, billingMode: "payg" }} onChange={select} />);
    const button = await screen.findByRole("button", { name: "Select model, current Kimi K2.6" });
    fireEvent.click(button);
    expect(await screen.findByText(/Uses OpenCode Go subscription limits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Kimi K2.6 by OpenCode Go" }));
    expect(select).toHaveBeenCalledWith(go);
  });

  it("exempts both legacy and stale payg Go selections from the budget without exempting Zen", async () => {
    const { modelUsesBillableBudget } = await import("@/components/model-selector");
    expect(modelUsesBillableBudget(go)).toBe(false);
    expect(modelUsesBillableBudget({ id: go.id })).toBe(false);
    expect(modelUsesBillableBudget({ ...go, billingMode: "payg" })).toBe(false);
    expect(modelUsesBillableBudget({ id: "opencode/kimi-k2.6", billingMode: "payg" })).toBe(true);
    expect(modelUsesBillableBudget({ id: "openrouter/moonshotai/kimi-k2.6" })).toBe(true);
  });
});
