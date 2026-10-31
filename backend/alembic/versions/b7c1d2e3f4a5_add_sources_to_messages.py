"""Add sources to messages

Revision ID: b7c1d2e3f4a5
Revises: af83b94b7635
Create Date: 2026-10-31 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7c1d2e3f4a5'
down_revision: Union[str, None] = 'af83b94b7635'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if 'messages' in insp.get_table_names():
        cols = [c['name'] for c in insp.get_columns('messages')]
        if 'sources' not in cols:
            op.add_column('messages', sa.Column('sources', sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if 'messages' in insp.get_table_names():
        cols = [c['name'] for c in insp.get_columns('messages')]
        if 'sources' in cols:
            op.drop_column('messages', 'sources')
