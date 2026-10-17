from datetime import datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

from app.core.config import settings
from app.db.session import get_db
from app.db.models import User, Workspace, Document, Chat

router = APIRouter()

try:
    _test_ctx = CryptContext(schemes=["argon2", "pbkdf2_sha256"], deprecated="auto")
    _test_ctx.hash("test")
    pwd_context = _test_ctx
except Exception:
    pwd_context = CryptContext(schemes=["pbkdf2_sha256", "argon2"], deprecated="auto")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/auth/login")

# Pydantic schemas
class UserCreate(BaseModel):
    username: str
    password: str = Field(..., max_length=72)

class Token(BaseModel):
    access_token: str
    token_type: str

class UserResponse(BaseModel):
    id: int
    username: str
    profile_context: Optional[str] = None
    custom_instructions: Optional[str] = None
    default_model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm="HS256")
    return encoded_jwt

def _record_active_session(user: User):
    """
    Persists the most recent authenticated user session to disk so the
    launcher endpoint knows which user to associate mapped folders with.
    """
    try:
        import os
        import json
        session_data = {
            "user_id": user.id,
            "username": user.username,
            "timestamp": datetime.utcnow().isoformat()
        }
        for base_dir in ["/app/data", "data"]:
            if os.path.exists(base_dir):
                target_file = os.path.join(base_dir, "active_session.json")
                with open(target_file, "w", encoding="utf-8") as f:
                    json.dump(session_data, f)
                break
    except Exception:
        pass


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception
        
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception

    _record_active_session(user)
    return user

@router.post("/register", response_model=UserResponse)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == user_in.username).first()
    if user:
        raise HTTPException(status_code=400, detail="Username already registered")
        
    hashed_password = get_password_hash(user_in.password)
    new_user = User(username=user_in.username, hashed_password=hashed_password)
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    # MIGRATION: If this is the FIRST user, assign all orphaned workspaces to them
    user_count = db.query(User).count()
    if user_count == 1:
        orphaned_workspaces = db.query(Workspace).filter(Workspace.user_id == None).all()
        for ws in orphaned_workspaces:
            ws.user_id = new_user.id
        db.commit()

    _record_active_session(new_user)
    return new_user

@router.post("/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
        
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    _record_active_session(user)
    return {"access_token": access_token, "token_type": "bearer"}

@router.get("/me", response_model=UserResponse)
def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user

class ChangePasswordRequest(BaseModel):
    new_password: str = Field(..., min_length=6, max_length=72)

class UpdateInstructionsRequest(BaseModel):
    profile_context: Optional[str] = None
    custom_instructions: Optional[str] = None

@router.put("/instructions", response_model=UserResponse)
def update_instructions(
    req: UpdateInstructionsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    current_user.profile_context = req.profile_context
    current_user.custom_instructions = req.custom_instructions
    db.commit()
    db.refresh(current_user)
    return current_user

class UpdateGenerationSettingsRequest(BaseModel):
    default_model: Optional[str] = None
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None

@router.put("/generation-settings", response_model=UserResponse)
def update_generation_settings(
    req: UpdateGenerationSettingsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    current_user.default_model = req.default_model
    current_user.temperature = req.temperature
    current_user.top_p = req.top_p
    current_user.max_tokens = req.max_tokens
    db.commit()
    db.refresh(current_user)
    return current_user

@router.post("/change-password")
def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    current_user.hashed_password = get_password_hash(req.new_password)
    db.commit()
    return {"detail": "Password changed successfully"}

