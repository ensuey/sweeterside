# sweeterside

Online menu for **Sweeter Side by Dachel** — a static page customers can browse on
their phone: search, filter by category, and tap any item for a larger photo.

## Getting started

There is no build step and no dependencies. Open `index.html` in a browser.

To serve it locally (needed if you want to test on your phone over Wi-Fi):

```bash
py -3 -m http.server 8000
# then visit http://localhost:8000
```

## Project layout

```
index.html              The whole menu — every item lives here as markup
assets/css/styles.css   Design tokens and all styling
assets/js/menu.js       Search + category filtering + the detail dialog
assets/*.jpg|png        The original menu posters and the logo
```

The menu works with JavaScript disabled — every item is real markup in
`index.html`. The script only adds search, filtering and the detail popup.

## Editing the menu

### Changing a name or price

Edit the item's `<li class="card">` block in `index.html`. Each item repeats its
price twice, so change both:

```html
<li class="card" data-cat="drinks" data-name="Matcha Frappe" data-price="129">
                                                             ^^^ detail popup
  ...
  <span class="price"><small>Php</small> 129</span>
            <!-- what the customer sees on the card ^^^ -->
```

`data-name` is what the search box matches against.

### Adding an item

Copy an existing `<li class="card">` block into the right section, then update
the name, price and photo. Also bump the number in that section's
`<span data-count>` and in the matching filter chip near the top of the file.

## How the photos work

There are only two photographs in this project — the original menu posters
(`assets/Menu Frappe.jpg` and `assets/Meals.jpg`), both 1021×1434. Each card
shows one product by displaying a **window** onto the poster, CSS-sprite style:

```html
<div class="shot" style="--x:113; --y:530; --w:184; --h:245">
```

- `--x`, `--y` — top-left corner of the crop, in source pixels
- `--w`, `--h` — size of the crop, in source pixels

`.shot` in `styles.css` turns those four numbers into the right scale and offset,
so the crops stay sharp and correct at every screen size. The crop windows were
chosen to sit fully inside each photo's white background — widen one too far and
the poster's yellow background creeps into the corner.

The upside is that the page loads **two images total** no matter how many items
you add. The downside is that a new item needs a new crop window. If you have
separate photos per product, that is strictly better: drop the `--x/--y/--w/--h`
style off `.shot` and point the `<img>` at your own file.

## Deploying

It is a folder of static files, so anything works — Netlify, Vercel, GitHub
Pages, Cloudflare Pages, or plain shared hosting. Upload the whole directory;
`index.html` must stay at the root.

## Still to fill in

The page deliberately claims nothing that has not been confirmed:

- **No contact details, address, hours or socials.** The footer is a stub. A
  menu customers find online usually needs at least a way to order or a link to
  your page — add it to the `<footer class="foot">` block.
- **No item descriptions.** Names and prices only, taken from the posters.
  Descriptions were left out rather than invented, since they imply ingredient
  and allergen claims.
