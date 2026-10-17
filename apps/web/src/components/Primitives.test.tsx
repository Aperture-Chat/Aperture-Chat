import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BrandIcon, Logo } from "./Primitives";

test("the collapsed sidebar never shrinks a wordmark into the icon slot", () => {
  const { container } = render(<Logo compact brand={{ chat_brand_name: "Acme", logo_url: "/wordmark.png" }} />);
  const image = container.querySelector("img") as HTMLImageElement;
  // The logo is tried as a stand-in icon, hidden until it proves square.
  expect(image).toHaveAttribute("src", "/wordmark.png");
  expect(image).toHaveAttribute("data-brand-pending");
  Object.defineProperties(image, { naturalWidth: { value: 1024 }, naturalHeight: { value: 211 } });
  fireEvent.load(image);
  expect(screen.getByRole("img", { name: "Acme" })).toHaveAttribute("src", "/brand/aperture-chat-icon.png");
});

test("a square stand-in icon is revealed once it loads", () => {
  const { container } = render(<BrandIcon sources={["/square.png"]} title="Compact icon" />);
  const image = container.querySelector("img") as HTMLImageElement;
  Object.defineProperties(image, { naturalWidth: { value: 300 }, naturalHeight: { value: 256 } });
  fireEvent.load(image);
  expect(container.querySelector("img")).not.toHaveAttribute("data-brand-pending");
});

test("a broken icon falls through to the next source", () => {
  const { container } = render(<BrandIcon sources={["/missing.png", "/logo.png"]} />);
  fireEvent.error(container.querySelector("img") as HTMLImageElement);
  expect(container.querySelector("img")).toHaveAttribute("src", "/logo.png");
});

test("an image-only logo stands alone and names the brand for assistive technology", () => {
  const { container } = render(<Logo brand={{ chat_brand_name: "", logo_url: "/wordmark.png" }} />);
  expect(container.querySelector(".logo")).toHaveClass("has-logo-image", "logo-image-only");
  expect(container.querySelector(".logo-word")).toBeNull();
  expect(screen.getByRole("img", { name: "Aperture Chat" })).toHaveAttribute("src", "/wordmark.png");
});

test("a logo keeps a configured name beside it", () => {
  const { container } = render(<Logo brand={{ chat_brand_name: "Acme", logo_url: "/logo.png", icon_url: "/icon.png" }} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "/logo.png");
  expect(container.querySelector(".logo-word")).toHaveTextContent("Acme");
});

test("without artwork the default wordmark spells the product name on its own", () => {
  const { container } = render(<Logo brand={{ chat_brand_name: "" }} />);
  expect(container.querySelector(".logo")).toHaveClass("has-logo-image", "logo-image-only");
  expect(container.querySelector(".logo-word")).toBeNull();
  expect(screen.getByRole("img", { name: "Aperture Chat" })).toHaveAttribute("src", "/brand/aperture-chat-logo.png");
});

test("a custom name without artwork keeps the default icon beside it", () => {
  const { container } = render(<Logo brand={{ chat_brand_name: "Litigation Desk" }} />);
  expect(container.querySelector(".logo")).not.toHaveClass("has-logo-image");
  expect(container.querySelector(".logo-word")).toHaveTextContent("Litigation Desk");
  expect(container.querySelector("img")).toHaveAttribute("src", "/brand/aperture-chat-icon.png");
});
