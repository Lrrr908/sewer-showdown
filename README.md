# Sewer Showdown - Party Wagon World

An interactive retro NES-style website where visitors drive the Party Wagon around to visit artist galleries!

## Quick Start

```bash
cd /home/beast/tmnt-art-show
python3 -m http.server 8080
```

Then open: http://localhost:8080

## Getting Sprites

Download NES TMNT sprites from The Spriters Resource:

### Required Sprites

1. **Party Wagon** - [TMNT NES Sprites](https://www.spriters-resource.com/nes/tmnt/)
   - Look for vehicle/van sprites
   
2. **Buildings/Tiles** - [TMNT Overworld](https://www.spriters-resource.com/nes/tmnt/)
   - Grab the map/overworld tiles
   
3. **Characters** (optional) - Use for decorations
   - Turtles, Shredder, enemies

### Where to Download

- **The Spriters Resource**: https://www.spriters-resource.com/nes/tmnt/
- **TMNT 2 Arcade**: https://www.spriters-resource.com/arcade/tmnt2/
- **TMNT 3 NES**: https://www.spriters-resource.com/nes/tmnt3/

Save sprites to the `sprites/` folder.

## Adding Your Artists

Edit `js/game.js` and update the `ARTISTS` array:

```javascript
const ARTISTS = [
    {
        id: 'artist1',
        name: 'ARTIST NAME',           // Shows in the info panel
        bio: 'Short bio here...',       // Description
        instagram: 'https://instagram.com/username',
        avatar: 'sprites/avatar1.png',  // Optional avatar image
        x: 5,                           // Grid position (0-15)
        y: 3                            // Grid position (0-11)
    },
    // Add more artists...
];
```

## Customizing the Map

The map is a 16x12 grid. Edit the `MAP` array in `game.js`:

```javascript
// Tile types:
// 0 = Grass
// 1 = Road (horizontal)
// 2 = Road (vertical)  
// 3 = Road (intersection)
// 4 = Water (blocks movement)
// 5 = Building (auto-placed by artists)
// 6 = Tree (blocks movement)
// 7 = Sewer entrance
```

## Controls

- **Arrow Keys** or **WASD** - Drive the Party Wagon
- **Enter** or **Space** - Visit artist's Instagram (when near building)
- **Mobile** - Touch controls appear automatically

## File Structure

```
tmnt-art-show/
├── index.html          # Main page
├── css/
│   └── style.css       # Retro styling
├── js/
│   └── game.js         # Game logic & artist config
├── sprites/            # Put your sprites here!
│   ├── party_wagon.png
│   ├── building.png
│   ├── tiles.png
│   └── avatar1.png (etc)
└── README.md
```

## Deployment

For a real website, just upload all files to any web host:
- GitHub Pages (free)
- Netlify (free)
- Vercel (free)
- Any web hosting

## Tips

1. **Sprite sizes** - Keep sprites around 48x48 pixels for best look
2. **Avatar images** - Square images work best (64x64 recommended)
3. **Building placement** - Don't place buildings on roads or water
4. **Test locally** - Always test with a local server, not file://

## Credits

- Original sprites from Konami's TMNT NES games
- Built for Sewer Showdown

COWABUNGA!
