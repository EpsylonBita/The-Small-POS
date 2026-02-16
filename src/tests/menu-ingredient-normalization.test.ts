import {
  ingredientMatchesFlavorTab,
  isExplicitDefaultIngredientLink,
  menuService,
  resolveIngredientColor,
  resolveIngredientFlavorType,
} from '../renderer/services/MenuService'

describe('ingredient normalization helpers', () => {
  it('resolves flavor from array-shaped ingredient_categories payload', () => {
    const resolved = resolveIngredientFlavorType({
      ingredient_categories: [
        { flavor_type: 'sweet' }
      ]
    } as any)

    expect(resolved).toBe('sweet')
  })

  it('uses deterministic hash color fallback when backend color is missing', () => {
    const first = resolveIngredientColor({ category_id: 'cat-a', category_name: 'Alpha' } as any)
    const second = resolveIngredientColor({ category_id: 'cat-b', category_name: 'Beta' } as any)
    const firstAgain = resolveIngredientColor({ category_id: 'cat-a', category_name: 'Alpha' } as any)

    expect(first).toMatch(/^#[0-9A-F]{6}$/)
    expect(second).toMatch(/^#[0-9A-F]{6}$/)
    expect(first).toBe(firstAgain)
    expect(first).not.toBe('#6B7280')
    expect(second).not.toBe('#6B7280')
    expect(first).not.toBe(second)
  })

  it('filters savory/sweet tabs strictly by resolved flavor', () => {
    expect(ingredientMatchesFlavorTab(null, 'savory')).toBe(false)
    expect(ingredientMatchesFlavorTab(null, 'sweet')).toBe(false)
    expect(ingredientMatchesFlavorTab('savory', 'savory')).toBe(true)
    expect(ingredientMatchesFlavorTab('sweet', 'sweet')).toBe(true)
    expect(ingredientMatchesFlavorTab('savory', 'sweet')).toBe(false)
    expect(ingredientMatchesFlavorTab('sweet', 'savory')).toBe(false)
  })

  it('treats missing is_default as non-default (no implicit preselection)', () => {
    expect(isExplicitDefaultIngredientLink({ ingredient_id: 'a' })).toBe(false)
    expect(isExplicitDefaultIngredientLink({ ingredient_id: 'a', is_default: 1 })).toBe(false)
    expect(isExplicitDefaultIngredientLink({ ingredient_id: 'a', is_default: true })).toBe(true)
  })

  it('returns full catalog availability when no links are configured', async () => {
    const allIngredients = [{ id: 'ing-1', name: 'A' }, { id: 'ing-2', name: 'B' }]
    const ingredientsSpy = jest
      .spyOn(menuService as any, 'getIngredients')
      .mockResolvedValue(allIngredients)
    const linksSpy = jest
      .spyOn(menuService as any, 'getMenuItemIngredients')
      .mockResolvedValue({ links: [], source: 'ipc' })

    const availability = await menuService.getAvailableIngredientsForItem('item-1')

    expect(availability.hasExplicitLinks).toBe(false)
    expect(availability.linkSource).toBe('ipc')
    expect(availability.ingredients).toEqual(allIngredients)

    linksSpy.mockRestore()
    ingredientsSpy.mockRestore()
  })

  it('returns full ingredient list when links are unavailable', async () => {
    const allIngredients = [{ id: 'ing-1', name: 'A' }]
    const ingredientsSpy = jest
      .spyOn(menuService as any, 'getIngredients')
      .mockResolvedValue(allIngredients)
    const linksSpy = jest
      .spyOn(menuService as any, 'getMenuItemIngredients')
      .mockResolvedValue({ links: [], source: 'unavailable' })

    const availability = await menuService.getAvailableIngredientsForItem('item-2')

    expect(availability.hasExplicitLinks).toBe(false)
    expect(availability.linkSource).toBe('unavailable')
    expect(availability.ingredients).toEqual(allIngredients)

    linksSpy.mockRestore()
    ingredientsSpy.mockRestore()
  })
})
