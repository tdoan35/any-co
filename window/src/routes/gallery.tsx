import { useLoaderData } from "react-router";
import { ShowcaseScreen } from "@/components/gallery/showcase-screen";
import { api } from "@/lib/api";

export async function galleryLoader() {
  const [gallery, games] = await Promise.all([
    api.getGallery().catch((err) => {
      // Adapters that predate /api/art-gallery answer 404; the calm empty gallery beats an
      // error page (the real state is the same: nothing kept on the checked-out branch yet).
      console.warn("[gallery] unavailable", err);
      return { repos: [] as string[], entries: [] };
    }),
    api.getShowcase(),
  ]);
  return { ...gallery, games };
}

/** The gallery is read-only material; switching studios remounts the app and re-runs this loader. */
export function GalleryPage() {
  const gallery = useLoaderData<typeof galleryLoader>();
  return <ShowcaseScreen repos={gallery.repos} entries={gallery.entries} games={gallery.games} />;
}
