const AVATAR_BASE = "assets/avatars/";

export const AVATARS = [
  "comic.svg",
  "knight.svg",
  "mermaid.svg",
  "john.svg",
  "dragon.svg",
  "detective.svg",
  "pirate.svg",
  "saymyname.png"
];

export function avatarMarkup(avatar, className = "avatar-svg") {
  if (typeof avatar === "string") {
    const safeName = avatar.split("/").pop();
    const extension = safeName.split(".").pop().toLowerCase();

    const supportedFormats = [
      "svg",
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp"
    ];

    if (
      supportedFormats.includes(extension) &&
      AVATARS.includes(safeName)
    ) {
      return `
        <img
          class="${className}"
          src="${AVATAR_BASE}${safeName}"
          alt=""
          draggable="false"
        >
      `;
    }
  }

  // Backward-compatible fallback for rooms created before image avatars.
  return `<span class="${className} avatar-fallback">${avatar || "?"}</span>`;
}