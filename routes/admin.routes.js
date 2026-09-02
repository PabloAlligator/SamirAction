const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const sharp = require('sharp');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

const rootPath = path.join(__dirname, '..');
const uploadsDir = path.join(rootPath, 'site', 'uploads', 'products');

const productImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter(req, file, callback) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

    if (!allowedTypes.includes(file.mimetype)) {
      return callback(new Error('Можно загружать только JPG, PNG или WEBP'));
    }

    callback(null, true);
  },
});

const ORDER_STATUSES = ['new', 'in_work', 'completed', 'cancelled'];

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    return next();
  }

  return res.status(401).json({
    message: 'Необходим вход в админку',
  });
}

function createCsrfToken(req) {
  const token = crypto.randomBytes(32).toString('hex');

  req.session.csrfToken = token;

  return token;
}

function validateCsrf(req, res, next) {
  const token = req.get('X-CSRF-Token');

  if (!token || !req.session?.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({
      message: 'CSRF token invalid',
    });
  }

  next();
}

function normalizeString(value, maxLength = 255) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function normalizeText(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .slice(0, maxLength);
}

function nullableString(value, maxLength = 255) {
  const normalized = normalizeString(value, maxLength);

  return normalized || null;
}

function toInt(value, fallback = 0) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(Math.round(number), 0);
}

function nullableInt(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  const normalized = Math.max(Math.round(number), 0);

  return normalized || null;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item, 500)).filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);

      if (Array.isArray(parsed)) {
        return parsed.map((item) => normalizeString(item, 500)).filter(Boolean);
      }
    } catch {
      return trimmed
        .split(',')
        .map((item) => normalizeString(item, 500))
        .filter(Boolean);
    }
  }

  return [];
}

function normalizeProduct(product) {
  if (!product) {
    return null;
  }

  const { sizesJson, imagesJson, ...data } = product;

  const now = new Date();
  const isPending =
    product.available &&
    product.publishAfter &&
    new Date(product.publishAfter).getTime() > now.getTime();

  return {
    ...data,
    sizes: parseJsonArray(sizesJson),
    images: parseJsonArray(imagesJson),
    adminStatus: !product.available
      ? 'hidden'
      : isPending
        ? 'pending'
        : 'published',
  };
}

function normalizeOrder(order) {
  if (!order) {
    return null;
  }

  const { itemsJson, ...data } = order;

  return {
    ...data,
    items: parseJsonArray(itemsJson),
  };
}

function createProductId(slug) {
  const cleanSlug = normalizeString(slug, 80)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${cleanSlug || 'product'}-${crypto.randomBytes(3).toString('hex')}`;
}

function getPublishAfterForNewProduct() {
  const delayHours = Number(process.env.PRODUCT_PUBLISH_DELAY_HOURS || 12);
  const safeDelayHours = Number.isFinite(delayHours) ? delayHours : 12;

  return new Date(Date.now() + safeDelayHours * 60 * 60 * 1000);
}

function buildProductData(body, { isCreate = false } = {}) {
  const title = normalizeString(body.title, 180);
  const slug = normalizeString(body.slug, 180)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const category = normalizeString(body.category || 'products', 100);
  const categoryTitle = normalizeString(body.categoryTitle || 'Товары', 120);
  const price = toInt(body.price);
  const sizes = normalizeArray(body.sizes);
  const images = normalizeArray(body.images);

  if (!title) {
    return {
      error: 'Введите название товара',
    };
  }

  if (!slug) {
    return {
      error: 'Введите slug товара',
    };
  }

  if (!category) {
    return {
      error: 'Введите категорию товара',
    };
  }

  if (!categoryTitle) {
    return {
      error: 'Введите название категории',
    };
  }

  if (!price) {
    return {
      error: 'Введите цену товара',
    };
  }

  const data = {
    slug,
    title,

    seoTitle: nullableString(body.seoTitle, 180),
    seoDescription: nullableString(body.seoDescription, 300),

    category,
    categoryTitle,

    price,
    oldPrice: nullableInt(body.oldPrice),

    badge: nullableString(body.badge, 80),
    isPopular: Boolean(body.isPopular),
    available: body.available !== false,

    bundle: nullableString(body.bundle, 180),
    color: nullableString(body.color, 120),
    sizesJson: JSON.stringify(sizes),
    imagesJson: JSON.stringify(images),

    shortDescription: nullableString(body.shortDescription, 500),
    description: normalizeText(body.description, 3000) || null,
    material: nullableString(body.material, 500),
    sku: nullableString(body.sku, 120),

    sortOrder: toInt(body.sortOrder, 100),
  };

  if (isCreate) {
    data.id = normalizeString(body.id, 120) || createProductId(slug);
    data.publishAfter = getPublishAfterForNewProduct();
  }

  return {
    data,
  };
}

router.post('/login', async (req, res) => {
  try {
    const login = normalizeString(req.body.login, 100);
    const password = String(req.body.password || '');

    const adminLogin = process.env.ADMIN_LOGIN;
    const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminLogin || !adminPasswordHash) {
      return res.status(500).json({
        message: 'Админка не настроена',
      });
    }

    if (login !== adminLogin) {
      return res.status(401).json({
        message: 'Неверный логин или пароль',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, adminPasswordHash);

    if (!isPasswordValid) {
      return res.status(401).json({
        message: 'Неверный логин или пароль',
      });
    }

    req.session.isAdmin = true;
    req.session.adminLogin = login;

    createCsrfToken(req);

    res.json({
      message: 'Вход выполнен',
    });
  } catch (error) {
    console.error('Admin login error:', error);

    res.status(500).json({
      message: 'Ошибка входа',
    });
  }
});

router.post('/logout', requireAdmin, validateCsrf, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('samirAdmin.sid');

    res.json({
      message: 'Вы вышли из админки',
    });
  });
});

router.get('/check', requireAdmin, (req, res) => {
  res.json({
    isAdmin: true,
    login: req.session.adminLogin,
  });
});

router.get('/csrf', requireAdmin, (req, res) => {
  res.json({
    csrfToken: req.session.csrfToken || createCsrfToken(req),
  });
});

router.post(
  '/uploads/product-image',
  requireAdmin,
  validateCsrf,
  productImageUpload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          message: 'Файл не загружен',
        });
      }

      await fs.mkdir(uploadsDir, {
        recursive: true,
      });

      const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
      const filePath = path.join(uploadsDir, fileName);

      await sharp(req.file.buffer)
        .rotate()
        .resize({
          width: 1400,
          height: 1400,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({
          quality: 82,
        })
        .toFile(filePath);

      res.status(201).json({
        url: `/site/uploads/products/${fileName}`,
      });
    } catch (error) {
      console.error('Product image upload error:', error);

      res.status(500).json({
        message: 'Не удалось загрузить изображение',
      });
    }
  },
);

router.get('/products', requireAdmin, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: [
        {
          sortOrder: 'asc',
        },
        {
          createdAt: 'desc',
        },
      ],
    });

    res.json(products.map(normalizeProduct));
  } catch (error) {
    console.error('Admin products read error:', error);

    res.status(500).json({
      message: 'Не удалось загрузить товары',
    });
  }
});

router.get('/products/:id', requireAdmin, async (req, res) => {
  try {
    const id = normalizeString(req.params.id, 120);

    const product = await prisma.product.findUnique({
      where: {
        id,
      },
    });

    if (!product) {
      return res.status(404).json({
        message: 'Товар не найден',
      });
    }

    res.json(normalizeProduct(product));
  } catch (error) {
    console.error('Admin product read error:', error);

    res.status(500).json({
      message: 'Не удалось загрузить товар',
    });
  }
});

router.post('/products', requireAdmin, validateCsrf, async (req, res) => {
  try {
    const result = buildProductData(req.body, {
      isCreate: true,
    });

    if (result.error) {
      return res.status(400).json({
        message: result.error,
      });
    }

    const slugExists = await prisma.product.findUnique({
      where: {
        slug: result.data.slug,
      },
    });

    if (slugExists) {
      return res.status(409).json({
        message: 'Товар с таким slug уже существует',
      });
    }

    const product = await prisma.product.create({
      data: result.data,
    });

    res.status(201).json({
      message: 'Товар успешно опубликован',
      product: normalizeProduct(product),
    });
  } catch (error) {
    console.error('Admin product create error:', error);

    res.status(500).json({
      message: 'Не удалось создать товар',
    });
  }
});

router.patch('/products/:id', requireAdmin, validateCsrf, async (req, res) => {
  try {
    const id = normalizeString(req.params.id, 120);

    const existingProduct = await prisma.product.findUnique({
      where: {
        id,
      },
    });

    if (!existingProduct) {
      return res.status(404).json({
        message: 'Товар не найден',
      });
    }

    const result = buildProductData(req.body);

    if (result.error) {
      return res.status(400).json({
        message: result.error,
      });
    }

    const slugOwner = await prisma.product.findUnique({
      where: {
        slug: result.data.slug,
      },
    });

    if (slugOwner && slugOwner.id !== id) {
      return res.status(409).json({
        message: 'Товар с таким slug уже существует',
      });
    }

    const product = await prisma.product.update({
      where: {
        id,
      },
      data: result.data,
    });

    res.json({
      message: 'Товар обновлен',
      product: normalizeProduct(product),
    });
  } catch (error) {
    console.error('Admin product update error:', error);

    res.status(500).json({
      message: 'Не удалось обновить товар',
    });
  }
});

router.patch(
  '/products/:id/visibility',
  requireAdmin,
  validateCsrf,
  async (req, res) => {
    try {
      const id = normalizeString(req.params.id, 120);
      const available = Boolean(req.body.available);

      const product = await prisma.product.update({
        where: {
          id,
        },
        data: {
          available,
        },
      });

      res.json({
        message: available ? 'Товар опубликован' : 'Товар скрыт',
        product: normalizeProduct(product),
      });
    } catch (error) {
      console.error('Admin product visibility error:', error);

      res.status(500).json({
        message: 'Не удалось изменить видимость товара',
      });
    }
  },
);

router.delete('/products/:id', requireAdmin, validateCsrf, async (req, res) => {
  try {
    const id = normalizeString(req.params.id, 120);

    await prisma.product.delete({
      where: {
        id,
      },
    });

    res.json({
      message: 'Товар удален',
    });
  } catch (error) {
    console.error('Admin product delete error:', error);

    res.status(500).json({
      message: 'Не удалось удалить товар',
    });
  }
});

router.get('/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(orders.map(normalizeOrder));
  } catch (error) {
    console.error('Admin orders read error:', error);

    res.status(500).json({
      message: 'Не удалось загрузить заявки',
    });
  }
});

router.patch('/orders/:id/status', requireAdmin, validateCsrf, async (req, res) => {
  try {
    const id = normalizeString(req.params.id, 120);
    const status = normalizeString(req.body.status, 40);

    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        message: 'Некорректный статус заявки',
      });
    }

    const order = await prisma.order.update({
      where: {
        id,
      },
      data: {
        status,
      },
    });

    res.json({
      message: 'Статус заявки обновлен',
      order: normalizeOrder(order),
    });
  } catch (error) {
    console.error('Admin order status error:', error);

    res.status(500).json({
      message: 'Не удалось обновить статус заявки',
    });
  }
});

module.exports = router;
