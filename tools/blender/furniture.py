"""悠悠自習室的原創家具:用 Blender 的 Python 介面建模並匯出成 GLB。

執行:  python tools/blender/furniture.py [輸出資料夾] [只做某幾件…]
需要:  pip install bpy

慣例:單位是公尺;家具正面朝 Blender 的 -Y(匯出後是遊戲裡的 +Z,朝向房間);
原點在佔地中心、底部貼地。材質用名字區分,遊戲端依名字套卡通材質與換色:
wood / woodDark(木頭,可換色)、fabric(布料,可換色)、shade(燈罩,會發光)、
screen(螢幕,遊戲端貼上畫面)、outline(描邊,外擴後翻面的殼)。
"""
import bpy, bmesh, math, random, sys, os
from mathutils import Matrix, Vector, Euler

PALETTE = {
    'wood': '#e6c9a2', 'woodDark': '#b88c63', 'white': '#f7f2e8', 'cream': '#efe3cf',
    'metal': '#9aa0b4', 'dark': '#4d4c60', 'fabric': '#7fa2e6', 'shade': '#fff1d2', 'screen': '#20233a',
    'bezel': '#3b3c50', 'key': '#f7f2e8', 'kbd': '#d5d9e6', 'plant': '#6fbf8a', 'pot': '#dc9470',
    'bookA': '#e79aa5', 'bookB': '#f2c078', 'bookC': '#9ccfa4', 'bookD': '#8fb7e3', 'bookE': '#b7a3e0', 'bookF': '#f4efe6',
    'outline': '#5b4638',
}
OUTLINE = 0.0045  # 描邊厚度(公尺)


def lin(hexcol):
    c = [int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return [((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c] + [1.0]


class Model:
    def __init__(self, name):
        self.name, self.bm, self.ol, self.mats = name, bmesh.new(), bmesh.new(), []
        self.uv = self.bm.loops.layers.uv.new('UVMap')

    def mat(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def _merge(self, tmp, mat, loc, rot, outline):
        """把暫存的形狀轉到定位、指定材質,併入模型(需要描邊的另存一份)。"""
        M = Matrix.Translation(Vector(loc)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
        bmesh.ops.transform(tmp, matrix=M, verts=tmp.verts)
        idx = self.mat(mat)
        for f in tmp.faces:
            f.material_index = idx
            f.smooth = True
        me = bpy.data.meshes.new('tmp')
        tmp.to_mesh(me)
        self.bm.from_mesh(me)
        if outline:
            self.ol.from_mesh(me)
        bpy.data.meshes.remove(me)
        tmp.free()

    def box(self, size, loc, mat, bevel=0.012, seg=2, rot=(0, 0, 0), outline=True):
        """圓角方塊。loc 是中心。"""
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=1.0)
        bmesh.ops.scale(tmp, vec=Vector(size), verts=tmp.verts)
        b = min(bevel, min(size) * 0.49)
        if b > 0.0005:
            bmesh.ops.bevel(tmp, geom=tmp.edges[:], offset=b, segments=seg, profile=0.5, affect='EDGES')
        self._merge(tmp, mat, loc, rot, outline)

    def cyl(self, r1, r2, depth, loc, mat, segs=28, rot=(0, 0, 0), bevel=0.0, outline=True):
        """圓柱或圓錐台,軸向為 Z。r1 是底部半徑、r2 是頂部半徑。"""
        tmp = bmesh.new()
        bmesh.ops.create_cone(tmp, cap_ends=True, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth)
        if bevel > 0.0005:
            rim = [e for e in tmp.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
            bmesh.ops.bevel(tmp, geom=rim, offset=min(bevel, depth * 0.45), segments=2, profile=0.5, affect='EDGES')
        self._merge(tmp, mat, loc, rot, outline)

    def ball(self, r, loc, mat, scale=(1, 1, 1), rot=(0, 0, 0), outline=True):
        tmp = bmesh.new()
        bmesh.ops.create_uvsphere(tmp, u_segments=20, v_segments=12, radius=r)
        bmesh.ops.scale(tmp, vec=Vector(scale), verts=tmp.verts)
        self._merge(tmp, mat, loc, rot, outline)

    def quad(self, w, h, loc, mat, rot=(0, 0, 0)):
        """朝 -Y 的平面,UV 鋪滿 0–1(螢幕畫面用)。"""
        vs = [self.bm.verts.new(Euler(rot, 'XYZ').to_matrix() @ Vector(p) + Vector(loc))
              for p in ((-w / 2, 0, -h / 2), (w / 2, 0, -h / 2), (w / 2, 0, h / 2), (-w / 2, 0, h / 2))]
        f = self.bm.faces.new(vs)
        f.material_index = self.mat(mat)
        for loop, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            loop[self.uv].uv = uv

    def export(self, outdir):
        # 描邊:把需要描邊的部分沿法線外擴一點、翻面,用深色不受光的材質畫出輪廓線
        self.ol.normal_update()
        for v in self.ol.verts:
            v.co += v.normal * OUTLINE
        bmesh.ops.reverse_faces(self.ol, faces=self.ol.faces[:])
        oi = self.mat('outline')
        for f in self.ol.faces:
            f.material_index = oi
        me = bpy.data.meshes.new('ol')
        self.ol.to_mesh(me)
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        for n in self.mats:
            m = bpy.data.materials.get(n) or bpy.data.materials.new(n)
            m.use_nodes = True
            bsdf = m.node_tree.nodes.get('Principled BSDF')
            bsdf.inputs['Base Color'].default_value = lin(PALETTE[n])
            bsdf.inputs['Roughness'].default_value = 0.9
            mesh.materials.append(m)
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        # 讓大平面保持平整、只有圓角帶出高光
        wn = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
        wn.keep_sharp = False
        wn.weight = 100
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        path = os.path.join(outdir, self.name + '.glb')
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                                  export_apply=True, export_normals=True, export_texcoords=True, export_materials='EXPORT')
        tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
        bb = [(min(v.co[i] for v in mesh.vertices), max(v.co[i] for v in mesh.vertices)) for i in range(3)]
        print(f'{self.name}: {tris} tris, {os.path.getsize(path) // 1024} KB, size '
              + ' x '.join(f'{b - a:.2f}' for a, b in bb))
        bpy.data.objects.remove(obj)
        self.bm.free(); self.ol.free()


# ---------------------------------------------------------------- 家具

def desk():
    """工作桌 1.5 × 0.7,高 0.74:右側三層抽屜櫃,左側板腳。正面(-Y)是坐人的那一側。"""
    m = Model('desk')
    W, D, H, T = 1.5, 0.7, 0.74, 0.04
    m.box((W, D, T), (0, 0, H - T / 2), 'wood', bevel=0.014)                       # 桌面
    m.box((0.035, D - 0.08, H - T), (-W / 2 + 0.05, 0, (H - T) / 2), 'wood')       # 左板腳
    m.box((W - 0.5, 0.025, 0.3), (-0.2, D / 2 - 0.07, H - T - 0.16), 'wood')       # 後擋板
    px, pw = W / 2 - 0.24, 0.4                                                     # 抽屜櫃
    m.box((pw, D - 0.08, H - T - 0.06), (px, 0, 0.06 + (H - T - 0.06) / 2), 'wood')
    for k, (z, hh) in enumerate(((0.585, 0.14), (0.43, 0.14), (0.215, 0.26))):
        m.box((pw - 0.04, 0.02, hh), (px, -D / 2 + 0.035, z), 'white', bevel=0.008)   # 抽屜面板
        m.box((0.11, 0.018, 0.016), (px, -D / 2 + 0.02, z + hh / 2 - 0.035), 'woodDark', bevel=0.006)  # 把手
    for sx in (-0.15, 0.15):                                                       # 櫃腳
        for sy in (-0.24, 0.24):
            m.cyl(0.018, 0.022, 0.06, (px + sx, sy, 0.03), 'woodDark', segs=12, outline=False)
    m.box((0.5, 0.012, 0.012), (-0.2, D / 2 - 0.085, H - T - 0.33), 'woodDark', bevel=0.004, outline=False)  # 理線桿
    return m


def chair():
    """電腦椅:五爪腳、氣壓桿、厚坐墊、微微後仰的椅背、扶手。座面高約 0.48,正面朝 -Y。"""
    m = Model('chair')
    for i in range(5):                                                             # 五爪腳與輪子
        a = math.radians(i * 72 + 18)
        dx, dy = math.cos(a), math.sin(a)
        m.box((0.30, 0.045, 0.03), (dx * 0.15, dy * 0.15, 0.085), 'dark', bevel=0.012, rot=(0, 0, a))
        m.ball(0.032, (dx * 0.29, dy * 0.29, 0.034), 'dark', scale=(1, 1, 1.05), outline=False)
    m.cyl(0.05, 0.04, 0.05, (0, 0, 0.1), 'dark', segs=16)
    m.cyl(0.022, 0.022, 0.26, (0, 0, 0.24), 'metal', segs=14)                      # 氣壓桿
    m.box((0.2, 0.2, 0.04), (0, 0, 0.385), 'dark', bevel=0.012)                    # 座椅底盤
    m.box((0.48, 0.47, 0.09), (0, -0.01, 0.45), 'fabric', bevel=0.04, seg=4)       # 坐墊
    m.box((0.06, 0.035, 0.34), (0, 0.235, 0.56), 'dark', bevel=0.012, rot=(-0.12, 0, 0))  # 椅背支架
    m.box((0.44, 0.075, 0.5), (0, 0.255, 0.84), 'fabric', bevel=0.035, seg=4, rot=(-0.14, 0, 0))  # 椅背
    for sx in (-1, 1):                                                             # 扶手
        m.box((0.03, 0.03, 0.2), (sx * 0.255, 0.03, 0.53), 'dark', bevel=0.01)
        m.box((0.05, 0.24, 0.03), (sx * 0.255, 0.0, 0.64), 'dark', bevel=0.013)
    return m


def bookcase():
    """開放書櫃 0.8 × 0.32,高 1.8:四層,放滿書、一個收納盒和小盆栽。背面貼牆。"""
    m = Model('bookcase')
    rnd = random.Random(7)
    W, D, H, T = 0.8, 0.32, 1.8, 0.028
    for sx in (-1, 1):
        m.box((T, D, H), (sx * (W / 2 - T / 2), 0, H / 2), 'wood')
    m.box((W - 2 * T, 0.012, H - 0.08), (0, D / 2 - 0.01, H / 2 + 0.03), 'cream', bevel=0.003, outline=False)  # 背板
    levels = [0.07, 0.47, 0.87, 1.27, H - T / 2]
    for z in levels:
        m.box((W - 2 * T + 0.004, D - 0.01, T), (0, 0, z), 'wood')
    m.box((W - 2 * T, 0.02, 0.055), (0, -D / 2 + 0.03, 0.03), 'woodDark', bevel=0.006)  # 踢腳板
    cols = ['bookA', 'bookB', 'bookC', 'bookD', 'bookE', 'bookF']
    inner = W - 2 * T - 0.03

    def row(z0, x0, x1, lean=True):
        x = x0
        while x < x1 - 0.02:
            t = rnd.uniform(0.022, 0.05)
            if x + t > x1:
                break
            hh, dd = rnd.uniform(0.19, 0.29), rnd.uniform(0.17, 0.22)
            tilt = 0.0
            if lean and x + t > x1 - 0.07 and rnd.random() < 0.7:      # 最後一本斜靠
                tilt = 0.22
            m.box((t, dd, hh), (x + t / 2 + math.sin(tilt) * hh / 2, -D / 2 + 0.035 + dd / 2, z0 + hh / 2 * math.cos(tilt)),
                  rnd.choice(cols), bevel=0.004, seg=1, rot=(0, tilt, 0))
            x += t + 0.002 + math.sin(tilt) * hh

    z = [l + T / 2 for l in levels[:-1]]
    row(z[3], -inner / 2, inner / 2 - 0.2)                                         # 最上層:書 + 盆栽
    m.cyl(0.045, 0.058, 0.09, (inner / 2 - 0.09, -0.02, z[3] + 0.045), 'pot', segs=16, bevel=0.008)
    for i in range(7):
        a = i * 0.9
        m.ball(0.04, (inner / 2 - 0.09 + math.cos(a) * 0.035, -0.02 + math.sin(a) * 0.035, z[3] + 0.12 + (i % 3) * 0.03),
               'plant', scale=(0.75, 0.75, 1.5), outline=False)
    row(z[2], -inner / 2, inner / 2)                                               # 第三層:整排書
    row(z[1], -inner / 2 + 0.3, inner / 2)                                         # 第二層:橫放的書 + 一排書
    zz = z[1]
    for k in range(3):
        t = rnd.uniform(0.03, 0.045)
        m.box((0.2, 0.26 - k * 0.012, t), (-inner / 2 + 0.13, -0.01, zz + t / 2), rnd.choice(cols), bevel=0.004, seg=1,
              rot=(0, 0, rnd.uniform(-0.12, 0.12)))
        zz += t + 0.001
    m.box((0.34, 0.25, 0.24), (-inner / 2 + 0.19, -0.015, z[0] + 0.12), 'cream', bevel=0.02, seg=3)   # 最下層:收納盒 + 書
    m.box((0.09, 0.012, 0.03), (-inner / 2 + 0.19, -0.145, z[0] + 0.17), 'woodDark', bevel=0.005, outline=False)
    row(z[0], -inner / 2 + 0.4, inner / 2)
    return m


def lamp():
    """檯燈,高約 0.44:圓底座、細燈桿、布燈罩(遊戲端會讓燈罩發光)。"""
    m = Model('lamp')
    m.cyl(0.085, 0.075, 0.022, (0, 0, 0.011), 'woodDark', segs=28, bevel=0.007)
    m.cyl(0.012, 0.012, 0.25, (0, 0, 0.145), 'metal', segs=12)
    m.ball(0.02, (0, 0, 0.275), 'metal', outline=False)
    m.cyl(0.125, 0.085, 0.17, (0, 0, 0.355), 'shade', segs=32, bevel=0.006)
    m.cyl(0.126, 0.126, 0.012, (0, 0, 0.272), 'cream', segs=32, outline=False)     # 燈罩下緣的滾邊
    return m


def monitor():
    """螢幕 + 鍵盤 + 滑鼠 + 馬克杯。佔 1 × 1 格,螢幕在後、鍵盤在前(-Y)。"""
    m = Model('monitor')
    # 螢幕
    sw, sh, sy, sz = 0.60, 0.36, 0.14, 0.32
    m.cyl(0.1, 0.1, 0.012, (0, sy + 0.02, 0.006), 'bezel', segs=28, bevel=0.004)
    m.box((0.04, 0.03, 0.2), (0, sy + 0.035, 0.11), 'bezel', bevel=0.01)
    m.box((sw, 0.028, sh), (0, sy, sz), 'bezel', bevel=0.012, seg=3)
    m.box((sw - 0.03, 0.006, sh - 0.03), (0, sy - 0.014, sz), 'screen', bevel=0.004, outline=False)
    m.quad(sw - 0.04, sh - 0.04, (0, sy - 0.0185, sz), 'screen')
    # 鍵盤
    kw, kd, ky = 0.36, 0.13, -0.2
    m.box((kw, kd, 0.016), (-0.05, ky, 0.008), 'kbd', bevel=0.006)
    rows, cols = 4, 13
    for r in range(rows):
        for c in range(cols):
            if r == rows - 1 and 3 <= c <= 8:
                continue
            m.box((0.021, 0.021, 0.008), (-0.05 - kw / 2 + 0.024 + c * 0.026, ky + kd / 2 - 0.022 - r * 0.027, 0.02),
                  'key', bevel=0.003, seg=1, outline=False)
    m.box((0.15, 0.021, 0.008), (-0.05 - kw / 2 + 0.024 + 5.5 * 0.026, ky + kd / 2 - 0.022 - 3 * 0.027, 0.02), 'key',
          bevel=0.003, seg=1, outline=False)                                       # 空白鍵
    # 滑鼠墊與滑鼠
    m.box((0.2, 0.17, 0.004), (0.3, ky, 0.002), 'dark', bevel=0.0015, outline=False)
    m.ball(0.034, (0.3, ky, 0.017), 'white', scale=(0.85, 1.35, 0.5))
    # 馬克杯
    m.cyl(0.036, 0.04, 0.085, (-0.36, -0.05, 0.0425), 'fabric', segs=20, bevel=0.006)
    m.cyl(0.031, 0.031, 0.004, (-0.36, -0.05, 0.083), 'woodDark', segs=20, outline=False)
    m.box((0.012, 0.03, 0.045), (-0.405, -0.05, 0.045), 'fabric', bevel=0.005, outline=False)
    return m


ALL = {'desk': desk, 'chair': chair, 'bookcase': bookcase, 'lamp': lamp, 'monitor': monitor}

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'assets', 'studio')
    os.makedirs(out, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name in (args[1:] or ALL):
        ALL[name]().export(out)
