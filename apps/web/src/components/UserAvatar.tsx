import { useEffect, useState } from "react";
import type { User } from "../lib/types";

type AvatarUser = Pick<User, "display_name" | "avatar_url">;

export function UserAvatar({
  user,
  className = "avatar",
}: {
  user: AvatarUser;
  className?: string;
}) {
  const avatarUrl = user.avatar_url?.trim() ?? "";
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  return (
    <span className={`${className} ${avatarUrl && !imageFailed ? "avatar-image" : "avatar-initials"}`} aria-hidden="true">
      {avatarUrl && !imageFailed ? (
        <img src={avatarUrl} alt="" onError={() => setImageFailed(true)} />
      ) : (
        userInitials(user.display_name)
      )}
    </span>
  );
}

export function userInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
