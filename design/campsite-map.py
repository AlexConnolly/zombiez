# Builds src/maps/campsite.json (Camp Morrow). Run from the repo root: python design/campsite-map.py
# One tile = 1 m. x runs west to east (0..49), z north to south (0..43). The palisade is the outer ring.
import json, math, random

W, D = 50, 44
GROUND_H, TOWER_Y = 3.5, 3.5
g = [[' '] * W for _ in range(D)]
top = [[' '] * W for _ in range(D)]


def fill(x0, z0, x1, z1, t, grid=g):
    for z in range(z0, z1 + 1):
        for x in range(x0, x1 + 1):
            grid[z][x] = t


def walls(x0, z0, x1, z1):
    """A building: log walls round a floor."""
    fill(x0, z0, x1, z1, '#')
    fill(x0 + 1, z0 + 1, x1 - 1, z1 - 1, '.')


fill(0, 0, W - 1, D - 1, '#')
fill(1, 1, W - 2, D - 2, '.')

# Fences between zones (F), with gates (D) that are the bought doors.
for z in range(1, 43): g[z][15] = 'F'
for z in range(11, 43): g[z][35] = 'F'
for x in range(36, 49): g[11][x] = 'F'

# Buildings.
walls(16, 0, 35, 10)  # mess hall; its north wall is the palisade
walls(4, 17, 12, 29)  # chapel
fill(12, 22, 12, 24, '.')  # chapel door, always open
for z0 in (19, 27, 35):  # sleeping cabins
    walls(39, z0, 45, z0 + 4)
    fill(39, z0 + 2, 39, z0 + 2, '.')
walls(44, 12, 48, 16)  # boathouse, against the palisade
fill(44, 14, 44, 14, '.')
fill(48, 13, 48, 15, '#')
walls(37, 2, 42, 7)  # Leader's cabin
fill(39, 7, 40, 7, '.')
walls(43, 0, 49, 9)  # watchtower, in the north-east corner of the palisade
fill(43, 7, 43, 8, '.')  # the players' doorway from the compound

doors = [
    {'id': 'messHall', 'floor': 'ground', 'cells': [[24, 10], [25, 10], [26, 10]], 'cost': 750, 'opens': 'B'},
    {'id': 'chapelGate', 'floor': 'ground', 'cells': [[15, 25], [15, 26], [15, 27]], 'cost': 1000, 'opens': 'C'},
    {'id': 'cabinGate', 'floor': 'ground', 'cells': [[35, 25], [35, 26], [35, 27]], 'cost': 1000, 'opens': 'D'},
    {'id': 'compoundGate', 'floor': 'ground', 'cells': [[41, 11], [42, 11], [43, 11]], 'cost': 1250, 'opens': 'E'},
    {'id': 'messHallBack', 'floor': 'ground', 'cells': [[35, 4], [35, 5], [35, 6]], 'cost': 1250, 'opens': 'E'},
]
for d in doors:
    for x, z in d['cells']: g[z][x] = 'D'

# Barricades in the palisade (and the mess hall's back wall, which is the palisade).
lake = lambda z: {'spawns': [[60 + i * 2, -1.3, z + 0.5 + (i - 1) * 2] for i in range(3)], 'approach': [[55, -0.5, z + 0.5], [50.4, 0, z + 0.5]]}
windows = [
    {'id': 'gate', 'floor': 'ground', 'cells': [[x, 43] for x in range(22, 28)], 'facing': 's', 'zone': 'A', 'boards': 10, 'opening': [0.2, 3]},
    {'id': 'woodpile', 'floor': 'ground', 'cells': [[x, 43] for x in range(31, 34)], 'facing': 's', 'zone': 'A', 'opening': [0.2, 2.6]},
    {'id': 'kitchen', 'floor': 'ground', 'cells': [[x, 0] for x in range(29, 31)], 'facing': 'n', 'zone': 'B', 'opening': [0, 2.4]},
    {'id': 'southWest', 'floor': 'ground', 'cells': [[x, 43] for x in range(6, 9)], 'facing': 's', 'zone': 'C', 'opening': [0.2, 2.6]},
    {'id': 'west', 'floor': 'ground', 'cells': [[0, z] for z in range(22, 25)], 'facing': 'w', 'zone': 'C', 'opening': [0.2, 2.6]},
    {'id': 'jetty', 'floor': 'ground', 'cells': [[49, z] for z in range(24, 27)], 'facing': 'e', 'zone': 'D', 'opening': [0.2, 2.6], **lake(25)},
    {'id': 'beach', 'floor': 'ground', 'cells': [[49, z] for z in range(37, 40)], 'facing': 'e', 'zone': 'D', 'opening': [0.2, 2.6], **lake(38)},
    {'id': 'north', 'floor': 'ground', 'cells': [[x, 0] for x in range(38, 41)], 'facing': 'n', 'zone': 'E', 'opening': [0.2, 2.6]},
    {'id': 'tower', 'floor': 'ground', 'cells': [[49, 2], [49, 3]], 'facing': 'e', 'zone': 'E', 'opening': [0, 2.4]},
]
for w in windows:
    for x, z in w['cells']: g[z][x] = 'W'

# The watchtower: stairs up the west side to an open platform with a parapet.
stairs = [{'floor': 'ground', 'cells': [[x, z] for z in range(2, 8) for x in (44, 45)], 'up': 'n'}]
for c in stairs[0]['cells']: g[c[1]][c[0]] = 'S'
fill(43, 0, 49, 9, 'F', top)
fill(44, 1, 48, 8, '.', top)
fill(44, 2, 45, 7, 'R', top)

traps = [
    {'id': 'bonfire', 'kind': 'fire', 'floor': 'ground', 'cell': [28, 31], 'cost': 1000, 'box': {'min': [19, -1, 21], 'max': [31, 3, 33]}, 'delay': 1, 'cooldown': 60, 'playerDamage': 50},
    {'id': 'bell', 'kind': 'bell', 'floor': 'ground', 'cell': [8, 19], 'cost': 750, 'box': {'min': [0, 0, 0], 'max': [0, 0, 0]}, 'delay': 0.2, 'cooldown': 90, 'playerDamage': 0, 'duration': 4},
]

P = lambda x, z, **k: {'floor': 'ground', 'cell': [x, z], **k}
secret_spots = [
    P(20, 33, name='tent'), P(24, 19, name='totem'), P(33, 2, name='pantry'), P(10, 23, name='pulpit'),
    P(43, 21, name='cabin bunk'), P(46, 15, name='boathouse'), P(41, 9, name='generator'), P(41, 3, name="Leader's desk"),
]

# Render-only scenery.
rnd = random.Random(7)
props = []
for _ in range(400):
    x, z = rnd.uniform(-35, 85), rnd.uniform(-35, 80)
    camp = -4 < x < 54 and -4 < z < 48
    road = 20 < x < 30 and z > 43
    water = x > 52 and -30 < z < 70
    if camp or road or water: continue
    props.append({'kind': 'pine', 'pos': [round(x, 1), 0, round(z, 1)], 'size': [1.6 + rnd.random(), 7 + rnd.random() * 6, 0]})
    if len(props) >= 140: break
for z in range(-30, 70, 4):
    props.append({'kind': 'pine', 'pos': [round(92 + rnd.random() * 6, 1), 0, z], 'size': [2, 9 + rnd.random() * 4, 0]})
for a in (0.3, 1.0, 2.15, 2.85, 3.6, 5.8):
    x, z = 25 + math.cos(a) * 9.5, 27 + math.sin(a) * 9.5
    props.append({'kind': 'tent', 'pos': [round(x, 1), 0, round(z, 1)], 'size': [2.4, 1.5, 2.2], 'rot': round(-a - math.pi / 2, 2), 'color': ['#5e5e44', '#5a4a3a', '#4a5a5a'][round(a * 3) % 3]})
for i in range(8):
    a = i / 8 * math.pi * 2 + math.pi / 8
    props.append({'kind': 'box', 'pos': [round(25 + math.cos(a) * 4.2, 2), 0, round(27 + math.sin(a) * 4.2, 2)], 'size': [2, 0.45, 0.5], 'rot': round(-a + math.pi / 2, 2), 'color': '#4a3322'})
props += [
    {'kind': 'totem', 'pos': [25.5, 0, 19.5], 'size': [1, 3.6, 1]},
    {'kind': 'roof', 'pos': [26, GROUND_H, 5.5], 'size': [20, 2.2, 11]},
    {'kind': 'roof', 'pos': [8.5, GROUND_H, 23.5], 'size': [9, 3, 13], 'color': '#2e2a26'},
    {'kind': 'box', 'pos': [8.5, 0, 16], 'size': [4, 9, 3], 'color': '#4e3c2c'},  # bell tower, overlapping the chapel's north wall
    {'kind': 'roof', 'pos': [8.5, 9, 16], 'size': [4, 2.4, 3]},
    *[{'kind': 'roof', 'pos': [42.5, GROUND_H, z0 + 2.5], 'size': [7, 1.4, 5]} for z0 in (19, 27, 35)],
    {'kind': 'roof', 'pos': [46.5, GROUND_H, 14.5], 'size': [5, 1.2, 5], 'color': '#33302a'},
    {'kind': 'roof', 'pos': [40, GROUND_H, 5], 'size': [6, 1.4, 6]},
    {'kind': 'roof', 'pos': [46.5, TOWER_Y + 3.4, 5], 'size': [7, 1.2, 10]},
    *[{'kind': 'box', 'pos': [x, TOWER_Y, z], 'size': [0.25, 3.4, 0.25], 'color': '#3a281a'} for x in (43.2, 49.8) for z in (0.2, 9.8)],
    {'kind': 'minibus', 'pos': [23.5, 0, 52], 'color': '#c8c4b8'},
    *[{'kind': 'box', 'pos': [29.3, 0.3 * i, 41.9], 'size': [2.2, 0.3, 1.1], 'color': '#5a3e28'} for i in range(4)],  # woodpile
    {'kind': 'box', 'pos': [56, -0.2, 25.5], 'size': [12, 0.4, 2], 'color': '#5a4630'},  # jetty
    {'kind': 'box', 'pos': [58, -0.15, 22], 'size': [3.5, 0.4, 1], 'color': '#6a3a2a'},  # rowing boat
    # Tables set for a meal that never finished.
    *[{'kind': 'box', 'pos': [22.5, 0, z], 'size': [11, 0.8, 1], 'color': '#6a4a30'} for z in (4, 7)],
    *[{'kind': 'box', 'pos': [x, 0.8, z + dz], 'size': [0.36, 0.06, 0.36], 'color': '#d8d4c8'} for z in (4, 7) for dz in (-0.3, 0.3) for x in range(18, 28, 2)],
    {'kind': 'box', 'pos': [31, 0, 1.5], 'size': [4.5, 0.95, 0.9], 'color': '#3a3a3a'},  # stove
    *[{'kind': 'box', 'pos': [8.5, 0, z], 'size': [5, 0.5, 0.5], 'color': '#4a3322'} for z in (21, 24, 27)],  # pews
    {'kind': 'box', 'pos': [39.5, 0, 9.3], 'size': [2.6, 2.2, 1.2], 'color': '#3e3a34'},  # generator shed
]
for x0, z0, x1, z1 in [(17, 1, 34, 9), (5, 18, 11, 28), (38, 3, 41, 6), (45, 13, 47, 15), *[(40, z0 + 1, 44, z0 + 3) for z0 in (19, 27, 35)]]:
    props.append({'kind': 'box', 'pos': [(x0 + x1 + 1) / 2, 0, (z0 + z1 + 1) / 2], 'size': [x1 - x0 + 0.96, 0.03, z1 - z0 + 0.96], 'color': '#4a3424'})

ground = [
    {'min': [-80, -1, -80], 'max': [52, -0.02, 130], 'color': '#141a12'},
    {'min': [52, -1, -80], 'max': [130, -0.02, -30], 'color': '#141a12'},
    {'min': [52, -1, 70], 'max': [130, -0.02, 130], 'color': '#141a12'},
    {'min': [90, -1, -30], 'max': [130, -0.02, 70], 'color': '#141a12'},
    {'min': [52, -3, -30], 'max': [90, -0.15, 70], 'color': '#0c1620'},
    {'min': [50, -1, -30], 'max': [52, -0.05, 70], 'color': '#3e382c'},
    {'min': [21, -1, 44], 'max': [29, 0.0, 130], 'color': '#26231e'},
]

camp = {
    'id': 'campsite', 'name': 'Camp Morrow', 'version': 1, 'cellSize': 1, 'wallHeight': GROUND_H, 'startZone': 'A',
    'floors': [
        {'id': 'ground', 'y': 0, 'tiles': [''.join(r) for r in g], 'wallColor': '#4a3322', 'floorColor': '#2c3424', 'open': True},
        {'id': 'tower', 'y': TOWER_Y, 'height': 2.5, 'tiles': [''.join(r) for r in top], 'floorColor': '#5a3e28', 'open': True},
    ],
    'playerSpawns': [P(23, 36), P(27, 36), P(23, 38), P(27, 38)],
    'windows': windows, 'doors': doors, 'stairs': stairs,
    'wallBuys': [P(20, 11, weapon='longshot', facing='n'), P(19, 1, weapon='ripper', facing='n'), P(38, 36, weapon='barnburner', facing='e'), P(40, 3, weapon='crossbow', facing='n')],
    'boxSpots': [P(27, 4, zone='B'), P(6, 20, zone='C'), P(43, 29, zone='D'), P(41, 4, zone='E')],
    'perks': [P(6, 27, perk='tough'), P(38, 3, perk='quick')],
    'power': P(36, 9, facing='w'),
    'lamps': [P(20, 20), P(30, 20), P(20, 34), P(30, 34), P(7, 36), P(37, 20), P(37, 10), P(17, 5)],
    'ambience': 'forest', 'zombieSkin': 'robe',
    'ground': ground, 'props': props, 'traps': traps,
    'secret': {'spots': secret_spots, 'count': 3, 'drop': P(7, 23), 'reward': 'dawn'},
}
json.dump(camp, open('src/maps/campsite.json', 'w'), indent=1)
print('\n'.join(camp['floors'][0]['tiles']))
