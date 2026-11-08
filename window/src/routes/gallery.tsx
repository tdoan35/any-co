import { useLoaderData } from "react-router";
import { GalleryScreen } from "@/components/gallery/gallery-screen";
import { api } from "@/lib/api";

export async function galleryLoader() {
  try {
    return await api.getGallery();
  } catch (err) {
    // Adapters that predate /api/art-gallery answer 404; the calm empty gallery beats an
    // error page (the real state is the same: nothing kept on the checked-out branch yet).
    console.warn("[gallery] unavailable", err);
    return { repos: [], entries: [] };
  }
}

/** The gallery is read-only material; switching studios remounts the app and re-runs this loader. */
export function GalleryPage() {
  const gallery = useLoaderData<typeof galleryLoader>();
  return <GalleryScreen repos={gallery.repos} entries={gallery.entries} />;
}
