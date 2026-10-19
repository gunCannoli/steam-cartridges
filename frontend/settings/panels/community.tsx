// Settings: Community Content (migration plan M8c; features plan F2 wires the first two toggles, F2c the manuals,
// ADR-0051 the disk cache slider).
// communityShowExternalLinks stays in the settings (default unchanged); it gets a row when something reads it.
import { Field, PanelSection } from "@steambrew/client";
import { MEDIA_CACHE_DAYS, useSetting } from "../settings";
import { Blocks, ItemRow, SliderRow, ToggleRow } from "../components";

// ===========================================================================
// Community Content Section
// ===========================================================================

export function CommunitySection() {
    const [showTrailers, setShowTrailers] = useSetting("communityShowTrailers");
    const [showArtworks, setShowArtworks] = useSetting("communityShowArtworks");
    const [showManuals, setShowManuals] = useSetting("communityShowManuals");
    const [cacheDays, setCacheDays] = useSetting("mediaCacheDays");

    return (
        <PanelSection title="Community Content">
            <Blocks>
                <>
                    <ItemRow>
                        <Field
                            label="For games with no Steam match"
                            description="Fills Steam's Community section from IGDB and ScreenScraper"
                            bottomSeparator="none"
                        />
                    </ItemRow>
                    <ToggleRow label="Gameplay Trailers" description="IGDB video trailers" value={showTrailers} onChange={setShowTrailers} />
                    <ToggleRow
                        label="Screenshots & Artwork"
                        description="IGDB and ScreenScraper images"
                        value={showArtworks}
                        onChange={setShowArtworks}
                    />
                    <ToggleRow label="Game Manuals" description="ScreenScraper manuals, shown first" value={showManuals} onChange={setShowManuals} />
                </>
                <>
                    {/* Label and description, then the slider across the full row. 0 keeps nothing on disk. */}
                    <ItemRow>
                        <Field
                            label="Cache downloaded media"
                            description="Days images and manuals stay on this PC. 0 keeps nothing."
                            bottomSeparator="none"
                        />
                    </ItemRow>
                    <SliderRow
                        value={cacheDays}
                        min={MEDIA_CACHE_DAYS.min}
                        max={MEDIA_CACHE_DAYS.max}
                        step={MEDIA_CACHE_DAYS.step}
                        suffix={cacheDays === 1 ? " day" : " days"}
                        resetValue={MEDIA_CACHE_DAYS.default}
                        onChange={setCacheDays}
                    />
                </>
            </Blocks>
        </PanelSection>
    );
}
