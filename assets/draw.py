# -*- coding: utf-8 -*-
"""Аватары бота: пиксель-арт 32x32 в палитре игры, апскейл x16 -> 512x512.
Telegram кадрирует аватар в круг, поэтому всё значимое держим в радиусе ~15 px."""
from PIL import Image, ImageDraw
import math, os

P = dict(ink='#140c1c', plum='#442434', navy='#30346d', slate='#4e4a4e',
         brown='#854c30', green='#346524', red='#d04648', gray='#757161',
         blue='#597dce', orange='#d27d2c', steel='#8595a1', leaf='#6daa2c',
         cyan='#6dc2ca', yellow='#dad45e', paper='#deeed6')
N, SCALE = 32, 16
OUT = os.path.dirname(os.path.abspath(__file__))

class Canvas:
    def __init__(self, bg='ink'):
        self.img = Image.new('RGB', (N, N), P[bg])
        self.d = ImageDraw.Draw(self.img)
        self.out = 0
    def box(self, x0, y0, x1, y1, c):
        self.d.rectangle([x0, y0, x1, y1], fill=P[c])
        for (x, y) in ((x0,y0),(x1,y0),(x0,y1),(x1,y1)):
            if math.hypot(x-15.5, y-15.5) > 15.5: self.out += 1
    def diamond(self, cx, cy, r, c):
        self.d.polygon([(cx, cy-r), (cx+r, cy), (cx, cy+r), (cx-r, cy)], fill=P[c])
    def disc(self, r, c):
        self.d.ellipse([15.5-r, 15.5-r, 15.5+r, 15.5+r], fill=P[c])

def save(cv, name):
    im = cv.img.resize((N*SCALE, N*SCALE), Image.NEAREST).convert('RGBA')
    ov = Image.new('RGBA', im.size, (0,0,0,0))          # намёк на CRT, как в игре
    d = ImageDraw.Draw(ov)
    for y in range(0, im.size[1], SCALE):
        d.rectangle([0, y, im.size[0], y+3], fill=(0,0,0,30))
    Image.alpha_composite(im, ov).convert('RGB').save(os.path.join(OUT, name))
    print('%-22s углов за кругом: %d' % (name, cv.out))

# --- A: голова робота, крупно ---------------------------------------------
a = Canvas('ink')
a.disc(15, 'plum'); a.disc(13, 'ink')                    # тонкое кольцо-подложка
a.box(15, 2, 16, 5, 'steel'); a.box(14, 1, 17, 2, 'red') # антенна
a.box(6, 5, 25, 26, 'slate')                             # корпус головы
a.box(7, 6, 24, 25, 'ink')
a.box(8, 7, 23, 24, 'cyan')
a.box(9, 9, 10, 10, 'steel'); a.box(21, 9, 22, 10, 'steel')   # болты
a.box(9, 12, 22, 18, 'ink')                              # визор
a.box(11, 14, 13, 16, 'yellow'); a.box(18, 14, 20, 16, 'yellow')
a.box(11, 14, 11, 14, 'paper'); a.box(18, 14, 18, 14, 'paper')
a.box(12, 21, 19, 22, 'ink')                             # решётка динамика
a.box(14, 21, 14, 22, 'cyan'); a.box(17, 21, 17, 22, 'cyan')
save(a, 'bot-a-robot.png')

# --- B: ящик на цели -------------------------------------------------------
b = Canvas('ink')
b.diamond(15, 15, 15, 'leaf'); b.diamond(15, 15, 13, 'green'); b.diamond(15, 15, 11, 'ink')
b.box(7, 7, 24, 24, 'orange')                            # ящик: рамка
b.box(9, 9, 22, 22, 'brown')
b.box(9, 14, 22, 16, 'orange'); b.box(14, 9, 16, 22, 'orange')   # обвязка
b.box(9, 9, 22, 9, 'gray'); b.box(9, 9, 9, 22, 'gray')   # фаска сверху-слева
b.box(9, 22, 22, 22, 'ink'); b.box(22, 9, 22, 22, 'ink') # тень снизу-справа
save(b, 'bot-b-crate.png')

# --- C: робот -> ящик -> цель (весь смысл игры одним кадром) --------------
c = Canvas('ink')
c.disc(15, 'plum'); c.disc(14, 'ink')
c.box(3, 24, 28, 25, 'slate'); c.box(3, 25, 28, 25, 'ink')       # пол
c.box(3, 8, 11, 17, 'slate'); c.box(4, 9, 10, 16, 'cyan')        # голова робота
c.box(5, 11, 9, 14, 'ink'); c.box(6, 12, 6, 13, 'yellow'); c.box(8, 12, 8, 13, 'yellow')
c.box(4, 18, 10, 23, 'ink'); c.box(5, 19, 9, 22, 'blue')         # корпус
c.box(6, 20, 8, 21, 'yellow')
c.box(11, 19, 13, 21, 'steel')                                   # рука толкает
c.box(13, 11, 22, 23, 'orange'); c.box(14, 12, 21, 22, 'brown')  # ящик
c.box(14, 16, 21, 18, 'orange'); c.box(17, 12, 18, 22, 'orange')
c.diamond(27, 17, 5, 'leaf'); c.diamond(27, 17, 3, 'green')      # цель
c.box(23, 16, 24, 18, 'paper')                                   # стрелка к цели
c.box(24, 15, 24, 19, 'paper')
save(c, 'bot-c-scene.png')
